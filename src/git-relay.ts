import { one, run, dataDir } from './db';
import { workspaceForAgent, type Workspace } from './workspace';

type Task={id:string,title:string,description:string,assignee_id:string|null,workspace_id:string|null,pr_url:string|null};
async function exec(argv:string[],cwd:string,timeoutMs=60000):Promise<string>{
 const proc=Bun.spawn(argv,{cwd,env:{HOME:process.env.HOME||'',PATH:'/opt/homebrew/bin:/usr/bin:/bin',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_EXTERNAL_DIFF:''},stdout:'pipe',stderr:'pipe',stdin:'ignore'});
 const timer=setTimeout(()=>proc.kill('SIGKILL'),timeoutMs);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
  if(code!==0)throw new Error((stderr||stdout).slice(0,1000)||`${argv[0]} exited ${code}`);
  return stdout.trim();
 }finally{clearTimeout(timer);}
}
const git='/opt/homebrew/bin/git',gh='/opt/homebrew/bin/gh';
const safeGit=[git,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=/usr/bin/false','-c','protocol.ext.allow=never','-c','protocol.file.allow=never'];
export function branchFor(agentName:string,taskId:string){
 const slug=agentName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30)||'agent';
 return `hive/${slug}/${taskId.slice(0,8)}`;
}
async function repoInfo(ws:Workspace){
 const rewrites=await exec([...safeGit,'config','--local','--name-only','--get-regexp','^url\\..*\\.insteadOf$'],ws.path).catch(()=> '');
 if(rewrites)throw new Error('Git URL rewrites are not allowed in a Hive workspace');
 const remote=await exec([...safeGit,'remote','get-url','origin'],ws.path);
 const match=remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
 if(!match)throw new Error('Only a github.com origin without embedded credentials is supported');
 if(!ws.github_repo||match[1]!==ws.github_repo)throw new Error('Origin does not match the repository pinned when this workspace was added');
 const defaultBranch=await exec([...safeGit,'symbolic-ref','--short','refs/remotes/origin/HEAD'],ws.path).then(x=>x.replace(/^origin\//,''),()=> 'main');
 return {repo:match[1],base:defaultBranch};
}
function assignedTask(agentId:string,taskId:string):Task {
 const task=one<Task>('SELECT * FROM tasks WHERE id=?',taskId);
 const workspace=workspaceForAgent(agentId);
 if(!task||task.assignee_id!==agentId||task.workspace_id!==workspace.id)throw new Error('Task must be assigned to this agent and workspace');
 return task;
}
export async function gitPush(agentId:string,agentName:string,taskId:string){
 const task=assignedTask(agentId,taskId),ws=workspaceForAgent(agentId);
 const branch=branchFor(agentName,task.id),info=await repoInfo(ws);
 const current=await exec([...safeGit,'branch','--show-current'],ws.path);
 if(current!==branch)throw new Error(`Switch to ${branch} before pushing`);
 const dirty=await exec([...safeGit,'status','--porcelain'],ws.path);
 if(dirty)throw new Error('Commit or discard local changes before pushing');
 const names=await exec([...safeGit,'diff','--no-ext-diff','--no-textconv','--name-only',`origin/${info.base}...HEAD`],ws.path);
 if(!names)throw new Error('No changes to push');
 if(names.split('\n').some(name=>/(^|\/)(\.env(?:\.|$)|access-token$)|\.(?:p12|p8|pem|key)$/i.test(name)))throw new Error('Potential credential file in diff');
 const diff=await exec([...safeGit,'diff','--no-ext-diff','--no-textconv',`origin/${info.base}...HEAD`],ws.path);
 if(diff.length>500000)throw new Error('Diff exceeds 500 KB');
 if(/ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY/.test(diff))throw new Error('Potential secret in diff');
 await exec([...safeGit,'-c','credential.helper=','-c',`credential.helper=!${gh} auth git-credential`,'push',`https://github.com/${info.repo}.git`,`HEAD:refs/heads/${branch}`],ws.path,120000);
 return {branch,repo:info.repo,base:info.base};
}
export async function createPr(agentId:string,agentName:string,taskId:string){
 const task=assignedTask(agentId,taskId),ws=workspaceForAgent(agentId);
 const branch=branchFor(agentName,task.id),info=await repoInfo(ws);
 const existing=await exec([gh,'pr','view',branch,'--repo',info.repo,'--json','url','--jq','.url'],dataDir).catch(()=>null);
 const url=existing||await exec([gh,'pr','create','--repo',info.repo,'--head',branch,'--base',info.base,'--title',task.title,'--body',task.description||`Hive task ${task.id}`],dataDir,120000);
 run('UPDATE tasks SET pr_url=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',url,'in_review',task.id);
 return url;
}
