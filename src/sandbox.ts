import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './db';
import type { Workspace } from './workspace';

function literal(path:string) { return JSON.stringify(path); }
export function sandboxProfile(workspacePath:string) {
 const ancestors:string[]=[];
 for(let path=dirname(workspacePath);path!=='/';path=dirname(path)) ancestors.push(path);
 const metadata=ancestors.map(path=>`(literal ${literal(path)})`).join(' ');
 return `(version 1)
(deny default)
(allow process*)
(allow mach-lookup)
(allow sysctl-read)
(allow file-read* (subpath "/"))
(deny file-read* (subpath "/Users"))
(deny file-read* (subpath "/Volumes"))
(allow file-read-metadata ${metadata})
(allow file-read* (subpath ${literal(workspacePath)}))
(deny file-read* (subpath ${literal(dataDir)}))
(allow file-write* (subpath ${literal(workspacePath)}))
(deny file-write* (subpath ${literal(dataDir)}))
(allow file-write* (subpath "/dev"))`;
}
async function limited(stream:ReadableStream<Uint8Array>,limit:number):Promise<string> {
 const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;if(size<limit){const part=value.slice(0,limit-size);chunks.push(part);size+=part.length;}}
 return new TextDecoder().decode(Buffer.concat(chunks));
}
export async function sandboxCommand(workspace:Workspace,command:string,timeoutMs=120000){
 if(command.length>8000) throw new Error('Command too long');
 const scratch=join(workspace.path,'.tmp','hive');mkdirSync(scratch,{recursive:true,mode:0o700});
 const proc=Bun.spawn(['/usr/bin/sandbox-exec','-p',sandboxProfile(workspace.path),'/bin/sh','-c',command],{
  cwd:workspace.path,env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:scratch,TMPDIR:scratch,USER:'hive',XDG_CACHE_HOME:scratch,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdout:'pipe',stderr:'pipe',stdin:'ignore'
 });
 const timer=setTimeout(()=>proc.kill('SIGKILL'),timeoutMs);
 try {
  const [stdout,stderr,exitCode]=await Promise.all([limited(proc.stdout,24000),limited(proc.stderr,12000),proc.exited]);
  return {exitCode,stdout,stderr:stderr.slice(0,12000),timedOut:proc.signalCode==='SIGKILL'};
 } finally {clearTimeout(timer);}
}
