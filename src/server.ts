import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { dataDir, projectRoot, all, one, run, id } from './db';
import { availableModels, trigger, stopAgent, setBroadcast, agentChanged, type Agent, type Channel } from './agent';
import { createWorkspace, listWorkspaces } from './workspace';

const host=process.env.HIVE_HOST||'127.0.0.1';
const port=Number(process.env.HIVE_PORT||4317);
const tokenPath=join(dataDir,'access-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath,crypto.randomUUID()+crypto.randomUUID(),{mode:0o600});
const token=readFileSync(tokenPath,'utf8').trim();
const app=Fastify({logger:false,bodyLimit:1024*1024});
await app.register(websocket);
const peers=new Set<{send:(text:string)=>void,readyState:number}>();
setBroadcast(event=>{const text=JSON.stringify(event);for(const peer of peers) if(peer.readyState===1) peer.send(text);});

function authorized(req:any) {
 const cookie=String(req.headers.cookie||'').split(';').map((v:string)=>v.trim()).find((v:string)=>v.startsWith('hive_token='))?.slice(11);
 const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
 return cookie===token||bearer===token;
}
app.addHook('onRequest',async(req,reply)=>{
 if(req.url.startsWith('/api/bootstrap')) return;
 if(req.url.startsWith('/api/') && !authorized(req)) return reply.code(401).send({error:'Unauthorized'});
});
app.get('/api/bootstrap',async(req:any,reply)=>{
 if(req.query?.token!==token) return reply.code(401).send({error:'Invalid token'});
 return reply.header('Set-Cookie',`hive_token=${token}; HttpOnly; SameSite=Strict; Path=/`).redirect('/');
});
app.get('/api/state',async()=>({
 agents:all<Agent>('SELECT * FROM agents ORDER BY created_at'),
 channels:all<Channel>('SELECT * FROM channels ORDER BY created_at DESC'),
 workspaces:listWorkspaces(),
 tasks:all('SELECT * FROM tasks ORDER BY updated_at DESC'),
 runs:all('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100'),
}));
app.get('/api/models',async()=>availableModels());
app.get('/api/channels/:id/messages',async(req:any,reply)=>{
 const ch=one('SELECT 1 FROM channels WHERE id=?',req.params.id);
 if(!ch) return reply.code(404).send({error:'Channel not found'});
 return all('SELECT * FROM messages WHERE channel_id=? ORDER BY created_at,id LIMIT 500',req.params.id);
});
app.get('/api/runs/:id/activities',async(req:any)=>all('SELECT * FROM activities WHERE run_id=? ORDER BY created_at,id',req.params.id));
app.post('/api/agents',async(req:any,reply)=>{
 const b=req.body||{};
 if(typeof b.name!=='string'||!b.name.trim()||typeof b.model!=='string') return reply.code(400).send({error:'Name and model required'});
 const models=await availableModels(); if(!models.some(m=>`${m.provider}/${m.id}`===b.model)) return reply.code(400).send({error:'Model unavailable'});
 const agent={id:id(),name:b.name.trim().slice(0,80),role:String(b.role||'').slice(0,2000),model:b.model,tools:JSON.stringify(['send_message','task_list']),workspace_id:null};
 run('INSERT INTO agents(id,name,role,model,tools) VALUES(?,?,?,?,?)',agent.id,agent.name,agent.role,agent.model,agent.tools);
 const ch={id:id(),kind:'dm',title:agent.name};
 run('INSERT INTO channels(id,kind,title) VALUES(?,?,?)',ch.id,ch.kind,ch.title);
 run('INSERT INTO channel_members(channel_id,member_id) VALUES(?,?)',ch.id,'human');
 run('INSERT INTO channel_members(channel_id,member_id) VALUES(?,?)',ch.id,agent.id);
 return {agent,channel:ch};
});
app.patch('/api/agents/:id',async(req:any,reply)=>{
 const old=one<Agent>('SELECT * FROM agents WHERE id=?',req.params.id); if(!old) return reply.code(404).send({error:'Agent not found'});
 const b=req.body||{}; const allowed=['send_message','agent_directory','message_agent','task_list','task_create','task_assign','task_handoff','task_update','ws_list','ws_read','ws_write','ws_bash','git_status','git_push','pr_create'];
 const tools=Array.isArray(b.tools)?['send_message',...new Set(b.tools.filter((x:any)=>allowed.includes(x)))]:JSON.parse(old.tools);
 const ws=b.workspace_id===undefined?old.workspace_id:b.workspace_id;
 if(ws && !one('SELECT 1 FROM workspaces WHERE id=?',ws)) return reply.code(400).send({error:'Workspace not found'});
 run('UPDATE agents SET name=?,role=?,tools=?,workspace_id=? WHERE id=?',String(b.name??old.name).slice(0,80),String(b.role??old.role).slice(0,2000),JSON.stringify(tools),ws,old.id);
 agentChanged(old.id);
 return one('SELECT * FROM agents WHERE id=?',old.id);
});
app.post('/api/channels',async(req:any,reply)=>{
 const b=req.body||{}; const members=Array.isArray(b.members)?b.members.filter((x:any)=>typeof x==='string'):[];
 if(members.length<1) return reply.code(400).send({error:'Choose at least one agent'});
 for(const member of members) if(!one('SELECT 1 FROM agents WHERE id=?',member)) return reply.code(400).send({error:'Unknown agent'});
 const ch={id:id(),kind:'group',title:String(b.title||'Group').slice(0,120)};
 run('INSERT INTO channels(id,kind,title) VALUES(?,?,?)',ch.id,ch.kind,ch.title);
 for(const member of ['human',...new Set(members)]) run('INSERT INTO channel_members(channel_id,member_id) VALUES(?,?)',ch.id,member);
 return ch;
});
app.post('/api/channels/:id/messages',async(req:any,reply)=>{
 const channel=one<Channel>('SELECT * FROM channels WHERE id=?',req.params.id);
 if(!channel) return reply.code(404).send({error:'Channel not found'});
 if(channel.kind==='agent_dm') return reply.code(403).send({error:'Agent private chats are read-only for people'});
 const text=String(req.body?.text||'').trim(); if(!text||text.length>20000) return reply.code(400).send({error:'Message must be 1–20000 characters'});
 const message={id:id(),channel_id:channel.id,author_id:'human',body:text,created_at:new Date().toISOString()};
 run('INSERT INTO messages(id,channel_id,author_id,body,created_at) VALUES(?,?,?,?,?)',message.id,message.channel_id,message.author_id,message.body,message.created_at);
 const members=all<{member_id:string}>('SELECT member_id FROM channel_members WHERE channel_id=? AND member_id!=?',channel.id,'human');
 for(const {member_id} of members) {
  const agent=one<Agent>('SELECT * FROM agents WHERE id=?',member_id);
  if(agent && (channel.kind==='dm'||text.includes(`@${agent.name}`))) trigger(member_id,channel.id,`Message from human in ${channel.title}: ${text}`);
 }
 for(const peer of peers) if(peer.readyState===1) peer.send(JSON.stringify({type:'message',message}));
 return message;
});
app.post('/api/agents/:id/stop',async(req:any)=>{await stopAgent(req.params.id,String(req.body?.channel_id||''));return {ok:true};});
app.post('/api/workspaces',async(req:any,reply)=>{
 try {const b=req.body||{};return createWorkspace(String(b.name||''),String(b.path||''));}
 catch(e){return reply.code(400).send({error:e instanceof Error?e.message:String(e)});}
});
app.post('/api/tasks',async(req:any,reply)=>{
 const b=req.body||{};if(!String(b.title||'').trim()) return reply.code(400).send({error:'Title required'});
 const assignee=b.assignee_id?one<Agent>('SELECT * FROM agents WHERE id=?',b.assignee_id):null;
 const task={id:id(),title:String(b.title).slice(0,200),description:String(b.description||'').slice(0,20000),status:'todo',assignee_id:assignee?.id||null,workspace_id:b.workspace_id||assignee?.workspace_id||null};
 run('INSERT INTO tasks(id,title,description,status,assignee_id,workspace_id) VALUES(?,?,?,?,?,?)',task.id,task.title,task.description,task.status,task.assignee_id,task.workspace_id);
 if(task.assignee_id) {
  const ch=one<{id:string}>('SELECT c.id FROM channels c JOIN channel_members m ON m.channel_id=c.id WHERE c.kind=? AND m.member_id=? LIMIT 1','dm',task.assignee_id);
  if(ch) trigger(task.assignee_id,ch.id,`Assigned task ${task.id}: ${task.title}\n${task.description}`);
 }
 return task;
});
app.patch('/api/tasks/:id',async(req:any,reply)=>{
 const old=one<any>('SELECT * FROM tasks WHERE id=?',req.params.id);if(!old)return reply.code(404).send({error:'Task not found'});
 const b=req.body||{};const valid=['backlog','todo','in_progress','in_review','blocked','done'];
 const status=valid.includes(b.status)?b.status:old.status;
 run('UPDATE tasks SET title=?,description=?,status=?,assignee_id=?,workspace_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',String(b.title??old.title).slice(0,200),String(b.description??old.description).slice(0,20000),status,b.assignee_id===undefined?old.assignee_id:b.assignee_id,b.workspace_id===undefined?old.workspace_id:b.workspace_id,old.id);
 return one('SELECT * FROM tasks WHERE id=?',old.id);
});
app.get('/api/events',{websocket:true},(socket,req)=>{
 if(!authorized(req)){socket.close(1008,'Unauthorized');return;}
 peers.add(socket);socket.on('close',()=>peers.delete(socket));
});

const contentTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
app.get('/*',async(req:any,reply)=>{
 const pathname=decodeURIComponent(req.url.split('?')[0]);
 if(pathname.includes('..'))return reply.code(404).send();
 const file=join(projectRoot,'dist',pathname==='/'?'index.html':pathname);
 const target=existsSync(file)?file:join(projectRoot,'dist','index.html');
 if(!existsSync(target))return reply.code(503).type('text/plain').send('Build the web app first: npm run build');
 return reply.type(contentTypes[extname(target)]||'application/octet-stream').send(Buffer.from(await Bun.file(target).arrayBuffer()));
});
await app.listen({host,port});
console.log(`Hive is running at http://${host}:${port}/api/bootstrap?token=${token}`);
