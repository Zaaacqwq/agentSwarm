import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { all, one, run, id, dataDir, projectRoot } from './db';
import { checkedPath, workspaceForAgent, withWorkspaceWrite } from './workspace';
import { sandboxCommand } from './sandbox';
import { loadTools, type Toolpack } from './toolpacks';
import { gitPush as relayGitPush, createPr as relayCreatePr } from './git-relay';

export type Agent = { id: string; name: string; role: string; model: string; tools: string; workspace_id: string | null };
export type Channel = { id: string; kind: 'dm'|'group'|'agent_dm'; title: string };
type Broadcast = (event: unknown) => void;
let broadcast: Broadcast = () => {};
export function setBroadcast(fn: Broadcast) { broadcast = fn; }
const queues = new Map<string, Promise<void>>();
const sessions = new Map<string, AgentSession>();
const dirtySessions = new Set<string>();
export function agentChanged(agentId:string){for(const key of sessions.keys())if(key.startsWith(agentId+':'))dirtySessions.add(key);}
const modelRuntime = await ModelRuntime.create();
export async function availableModels() {
 const models = await modelRuntime.getAvailable();
 return models.filter(m => m.provider === 'openrouter' || m.provider === 'openai-compatible').map(m => ({provider:m.provider,id:m.id,name:m.name}));
}

function grant(agentId: string, name: string) {
 const agent = one<Agent>('SELECT * FROM agents WHERE id=?', agentId);
 if (!agent || !JSON.parse(agent.tools).includes(name)) throw new Error(`Tool ${name} is not authorized`);
 return agent;
}
function dmFor(agentId:string):string {
 const ch=one<{id:string}>('SELECT c.id FROM channels c JOIN channel_members m ON m.channel_id=c.id WHERE c.kind=? AND m.member_id=? LIMIT 1','dm',agentId);
 if(!ch) throw new Error('Agent has no private channel');
 return ch.id;
}
function tool<T extends ReturnType<typeof Type.Object>>(agentId: string, name: string, description: string, parameters: T, fn: (p: any) => Promise<string> | string): ToolDefinition {
 return {name,label:name,description,parameters,async execute(_id, params) {
  try { grant(agentId,name); return {content:[{type:'text',text:String(await fn(params)).slice(0,12000)}],details:undefined}; }
  catch (e) { return {content:[{type:'text',text:`Error: ${e instanceof Error ? e.message : String(e)}`}],details:undefined}; }
 }};
}
function toolsFor(agentId: string, channelId: string): ToolDefinition[] {
 const send = tool(agentId,'send_message','Publish a message to this conversation. Only this tool makes your response visible to people.',Type.Object({text:Type.String()}), ({text}) => {
  const member = one('SELECT 1 FROM channel_members WHERE channel_id=? AND member_id=?',channelId,agentId);
  if (!member) throw new Error('Not a channel member');
  const message = {id:id(),channel_id:channelId,author_id:agentId,body:text.slice(0,20000),created_at:new Date().toISOString()};
  run('INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)',message.id,message.channel_id,message.author_id,message.body,message.created_at);
  broadcast({type:'message',message});
  return 'Message sent';
 });
 const agentDirectory=tool(agentId,'agent_directory','List other agents and their IDs for coordination.',Type.Object({}),()=>JSON.stringify(all('SELECT id,name,role FROM agents WHERE id!=? ORDER BY name',agentId)));
 const messageAgent=tool(agentId,'message_agent','Send a private message to another agent by ID or exact name. Ongoing exchanges are capped.',Type.Object({agent_id:Type.String(),text:Type.String()}),({agent_id,text})=>{
  const matches=all<{id:string}>('SELECT id FROM agents WHERE id=? OR lower(name)=lower(?)',agent_id,agent_id);
  if(matches.length!==1)throw new Error(matches.length?'Agent name is ambiguous':'Unknown agent; use agent_directory');
  const target=matches[0].id;
  if(target===agentId)throw new Error('Cannot message yourself');
  let channel=one<{id:string}>('SELECT c.id FROM channels c JOIN channel_members a ON a.channel_id=c.id JOIN channel_members b ON b.channel_id=c.id WHERE c.kind=? AND a.member_id=? AND b.member_id=? LIMIT 1','agent_dm',agentId,target);
  if(!channel){
   channel={id:id()};run('INSERT INTO channels(id,kind,title) VALUES(?,?,?)',channel.id,'agent_dm','Agent private chat');
   run('INSERT INTO channel_members(channel_id,member_id) VALUES(?,?)',channel.id,agentId);
   run('INSERT INTO channel_members(channel_id,member_id) VALUES(?,?)',channel.id,target);
  }
  const recent=all<{author_id:string}>('SELECT author_id FROM messages WHERE channel_id=? ORDER BY created_at DESC,id DESC LIMIT 6',channel.id);
  if(recent.length>=6 && recent.every(m=>m.author_id!=='human')) throw new Error('Agent exchange limit reached; ask a person to continue');
  const body=String(text).slice(0,10000);
  const message={id:id(),channel_id:channel.id,author_id:agentId,body,created_at:new Date().toISOString()};
  run('INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)',message.id,message.channel_id,message.author_id,message.body,message.created_at);
  broadcast({type:'message',message});
  trigger(target,channel.id,`Private message from another agent: ${body}`);
  return 'Private message sent';
 });
 const taskList = tool(agentId,'task_list','List tasks and their status.',Type.Object({}),() => JSON.stringify(all('SELECT id,title,status,assignee_id FROM tasks ORDER BY updated_at DESC LIMIT 50')));
 const taskCreate=tool(agentId,'task_create','Create a task with a title and description.',Type.Object({title:Type.String(),description:Type.String()}),({title,description})=>{
  if(!String(title).trim())throw new Error('Title required');const taskId=id();
  run('INSERT INTO tasks(id,title,description) VALUES(?,?,?)',taskId,String(title).slice(0,200),String(description).slice(0,20000));
  broadcast({type:'task',task_id:taskId});return `Created task ${taskId}`;
 });
 const taskAssign=tool(agentId,'task_assign','Assign an existing task to another agent.',Type.Object({task_id:Type.String(),agent_id:Type.String()}),({task_id,agent_id:target})=>{
  const task=one<{title:string,description:string}>('SELECT title,description FROM tasks WHERE id=?',task_id);
  const recipient=one<Agent>('SELECT * FROM agents WHERE id=?',target);
  if(!task||!recipient)throw new Error('Unknown task or agent');
  run('UPDATE tasks SET assignee_id=?,workspace_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',target,recipient.workspace_id,'todo',task_id);
  trigger(target,dmFor(target),`Assigned task ${task_id}: ${task.title}\n${task.description}`);
  broadcast({type:'task',task_id});return 'Task assigned';
 });
 const taskHandoff=tool(agentId,'task_handoff','Hand a task to another agent with a complete summary of completed work, remaining work, branch, and verification.',Type.Object({task_id:Type.String(),to_agent_id:Type.String(),summary:Type.String()}),({task_id,to_agent_id,summary})=>{
  const task=one<{title:string,assignee_id:string|null}>('SELECT title,assignee_id FROM tasks WHERE id=?',task_id);
  if(!task||task.assignee_id!==agentId)throw new Error('Task is not assigned to you');
  if(!one('SELECT 1 FROM agents WHERE id=?',to_agent_id))throw new Error('Unknown target agent');
  if(String(summary).trim().length<30)throw new Error('Handoff summary must be at least 30 characters');
  run('INSERT INTO task_handoffs(id,task_id,from_agent_id,to_agent_id,summary) VALUES(?,?,?,?,?)',id(),task_id,agentId,to_agent_id,String(summary).slice(0,20000));
  const recipient=one<Agent>('SELECT * FROM agents WHERE id=?',to_agent_id)!;
  run('UPDATE tasks SET assignee_id=?,workspace_id=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',to_agent_id,recipient.workspace_id,'todo',task_id);
  trigger(to_agent_id,dmFor(to_agent_id),`Task handoff ${task_id} (${task.title}) from another agent:\n${summary}`);
  broadcast({type:'task',task_id});return 'Task handed off';
 });
 const taskUpdate = tool(agentId,'task_update','Update a task assigned to you.',Type.Object({task_id:Type.String(),status:Type.Union([Type.Literal('todo'),Type.Literal('in_progress'),Type.Literal('in_review'),Type.Literal('blocked'),Type.Literal('done')])}),({task_id,status}) => {
  const task = one<{assignee_id:string|null}>('SELECT assignee_id FROM tasks WHERE id=?',task_id);
  if (!task || task.assignee_id !== agentId) throw new Error('Task is not assigned to this agent');
  run('UPDATE tasks SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',status,task_id);
  broadcast({type:'task',task_id}); return 'Updated';
 });
 const wsList = tool(agentId,'ws_list','List files in your assigned workspace.',Type.Object({path:Type.Optional(Type.String())}),async ({path}) => {
  const ws=workspaceForAgent(agentId); const target=checkedPath(ws.path,path||'.');
  return (await Array.fromAsync(new Bun.Glob('*').scan({cwd:target,onlyFiles:false}))).slice(0,200).join('\n');
 });
 const wsRead = tool(agentId,'ws_read','Read a UTF-8 file in your assigned workspace.',Type.Object({path:Type.String()}),async ({path}) => {
  const ws=workspaceForAgent(agentId); const target=checkedPath(ws.path,path);
  const file=Bun.file(target); if (file.size>100000) throw new Error('File too large');
  return await file.text();
 });
 const wsWrite = tool(agentId,'ws_write','Write a UTF-8 file in your assigned workspace.',Type.Object({path:Type.String(),content:Type.String()}),async ({path,content}) => {
  const ws=workspaceForAgent(agentId); const target=checkedPath(ws.path,path);
  if (content.length>100000) throw new Error('Content too large');
  return withWorkspaceWrite(ws.id,async()=>{await Bun.write(target,content);return `Wrote ${path}`;});
 });
 const wsBash = tool(agentId,'ws_bash','Run a command inside a macOS sandbox scoped to the assigned workspace. Network and other users\' files are denied. Use for tests and local git commands.',Type.Object({command:Type.String()}),async ({command})=>{
  const ws=workspaceForAgent(agentId);const result=await withWorkspaceWrite(ws.id,()=>sandboxCommand(ws,command));
  return JSON.stringify(result);
 });
 const gitStatus=tool(agentId,'git_status','Show git status and current branch in your assigned workspace.',Type.Object({}),async()=>JSON.stringify(await sandboxCommand(workspaceForAgent(agentId),'git status --short --branch')));
 const gitPushTool=tool(agentId,'git_push','Push the assigned task branch through Hive Git Relay. The branch must be hive/<agent>/<task> and committed.',Type.Object({task_id:Type.String()}),async({task_id})=>{
  const agent=grant(agentId,'git_push');const ws=workspaceForAgent(agentId);
  return JSON.stringify(await withWorkspaceWrite(ws.id,()=>relayGitPush(agentId,agent.name,task_id)));
 });
 const prCreate=tool(agentId,'pr_create','Create a GitHub pull request for the assigned task after git_push.',Type.Object({task_id:Type.String()}),async({task_id})=>{
  const agent=grant(agentId,'pr_create');const url=await relayCreatePr(agentId,agent.name,task_id);
  broadcast({type:'task',task_id});return url;
 });
 const packs:Toolpack[]=[
  {id:'core.communication',tools:()=>[send,agentDirectory,messageAgent],healthcheck:async()=>({available:true})},
  {id:'core.tasks',tools:()=>[taskList,taskCreate,taskAssign,taskHandoff,taskUpdate],healthcheck:async()=>({available:true})},
  {id:'core.workstation',tools:()=>[wsList,wsRead,wsWrite,wsBash],leases:['workstation-write'],healthcheck:async()=>({available:!!process.env.PATH}),guidance:'Use workspace paths and report test results.'},
  {id:'core.git',tools:()=>[gitStatus,gitPushTool,prCreate],healthcheck:async()=>({available:true})},
 ];
 const agent=one<Agent>('SELECT * FROM agents WHERE id=?',agentId);
 return loadTools(packs,{agentId,channelId},agent?JSON.parse(agent.tools):[]);
}

async function sessionFor(agent:Agent, channelId:string):Promise<AgentSession> {
 const key=`${agent.id}:${channelId}`;
 if(dirtySessions.delete(key)){sessions.get(key)?.dispose();sessions.delete(key);}
 const cached=sessions.get(key); if(cached) return cached;
 // Model IDs can contain slashes, so split only the provider prefix.
 const slash=agent.model.indexOf('/');
 const selected=modelRuntime.getModel(agent.model.slice(0,slash),agent.model.slice(slash+1));
 if (!selected) throw new Error(`Model unavailable: ${agent.model}`);
 const sessionDir=join(dataDir,'sessions',agent.id,channelId);
 mkdirSync(sessionDir,{recursive:true,mode:0o700});
 const prior=one<{path:string}>('SELECT path FROM sessions WHERE agent_id=? AND channel_id=?',agent.id,channelId);
 const manager=prior ? SessionManager.open(prior.path,sessionDir,projectRoot) : SessionManager.create(projectRoot,sessionDir);
 const agentDir=join(dataDir,'pi'); mkdirSync(agentDir,{recursive:true,mode:0o700});
 const loader=new DefaultResourceLoader({cwd:projectRoot,agentDir,
  systemPromptOverride:()=>`You are ${agent.name}, a member of Hive. Role: ${agent.role}. Use send_message to publish messages. Your ordinary assistant output is private. Follow tool permissions. Never claim a task is done without checking evidence.`,
  appendSystemPromptOverride:()=>[]});
 await loader.reload();
 const customTools=toolsFor(agent.id,channelId);
 const enabled=JSON.parse(agent.tools) as string[];
 const {session}=await createAgentSession({cwd:projectRoot,agentDir,modelRuntime,model:selected,resourceLoader:loader,sessionManager:manager,noTools:'all',customTools,tools:customTools.filter(t=>enabled.includes(t.name)).map(t=>t.name)});
 if (!prior && session.sessionFile) run('INSERT INTO sessions(agent_id,channel_id,path) VALUES(?,?,?)',agent.id,channelId,session.sessionFile);
 sessions.set(key,session);
 return session;
}

export function trigger(agentId:string,channelId:string,message:string) {
 const previous=queues.get(agentId)||Promise.resolve();
 const next=previous.catch(()=>{}).then(()=>executeRun(agentId,channelId,message));
 queues.set(agentId,next);
 next.finally(()=>{if(queues.get(agentId)===next) queues.delete(agentId);}).catch(()=>{});
}
async function executeRun(agentId:string,channelId:string,message:string) {
 const agent=one<Agent>('SELECT * FROM agents WHERE id=?',agentId);
 if (!agent) return;
 const runId=id(); run('INSERT INTO runs(id,agent_id,channel_id,status) VALUES(?,?,?,?)',runId,agentId,channelId,'running');
 broadcast({type:'run',run:{id:runId,agent_id:agentId,channel_id:channelId,status:'running'}});
 try {
  const session=await sessionFor(agent,channelId);
  const beforeMessages=one<{n:number}>('SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND author_id=?',channelId,agentId)?.n||0;
  const beforeContext=session.messages.length;
  const unsubscribe=session.subscribe((event:any)=>{
   if(event.type==='tool_execution_start') {
    const summary=String(event.toolName||'tool');
    run('INSERT INTO activities(id,run_id,type,summary) VALUES(?,?,?,?)',id(),runId,'tool',summary);
    broadcast({type:'activity',run_id:runId,summary});
   }
  });
  const timeout=setTimeout(()=>session.abort().catch(()=>{}),300000);
  try {
   await session.prompt(message);
   const afterMessages=one<{n:number}>('SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND author_id=?',channelId,agentId)?.n||0;
   if(afterMessages===beforeMessages && JSON.parse(agent.tools).includes('send_message')) {
    await session.prompt('Your previous turn did not publish a message. Summarize the outcome for the person now using send_message.');
   }
  } finally {clearTimeout(timeout);unsubscribe();}
  const finalMessages=one<{n:number}>('SELECT COUNT(*) AS n FROM messages WHERE channel_id=? AND author_id=?',channelId,agentId)?.n||0;
  if(finalMessages===beforeMessages) throw new Error('Agent ended without publishing a message');
  const usage=session.messages.slice(beforeContext).reduce((sum:any,item:any)=>{
   const u=item?.usage;if(u){sum.input+=u.input||0;sum.output+=u.output||0;sum.cost+=u.cost?.total||0;}return sum;
  },{input:0,output:0,cost:0});
  run('UPDATE runs SET status=?,ended_at=CURRENT_TIMESTAMP,input_tokens=?,output_tokens=?,cost=? WHERE id=?','done',usage.input,usage.output,usage.cost,runId);
  broadcast({type:'run',run:{id:runId,agent_id:agentId,channel_id:channelId,status:'done'}});
 } catch(e) {
  const error=e instanceof Error?e.message:String(e);
  run('UPDATE runs SET status=?,error=?,ended_at=CURRENT_TIMESTAMP WHERE id=?','failed',error,runId);
  broadcast({type:'run',run:{id:runId,agent_id:agentId,channel_id:channelId,status:'failed',error}});
 }
}
export function stopAgent(agentId:string,channelId:string) { return sessions.get(`${agentId}:${channelId}`)?.abort(); }
