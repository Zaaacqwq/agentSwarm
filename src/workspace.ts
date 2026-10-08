import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { all, one, run, id, dataDir } from './db';

export type Workspace = { id: string; name: string; path: string; github_repo:string|null };
export function createWorkspace(name: string, path: string): Workspace {
 const canonical = realpathSync(path);
 if (!statSync(canonical).isDirectory()) throw new Error('Workspace must be a directory');
 if (!canonical.startsWith('/Volumes/Data/')) throw new Error('Workspace must be on /Volumes/Data');
 const origin=Bun.spawnSync(['/opt/homebrew/bin/git','-C',canonical,'remote','get-url','origin'],{stdout:'pipe',stderr:'ignore'});
 const remote=origin.exitCode===0?new TextDecoder().decode(origin.stdout).trim():'';
 const match=remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
 const ws = { id: id(), name: name.trim(), path: canonical, github_repo:match?.[1]||null };
 run('INSERT INTO workspaces(id,name,path,github_repo) VALUES(?,?,?,?)', ws.id, ws.name, ws.path, ws.github_repo);
 return ws;
}
export function listWorkspaces() { return all<Workspace>('SELECT * FROM workspaces ORDER BY name'); }
export function workspaceForAgent(agentId: string): Workspace {
 const ws = one<Workspace>('SELECT w.* FROM workspaces w JOIN agents a ON a.workspace_id=w.id WHERE a.id=?', agentId);
 if (!ws) throw new Error('Agent has no workspace');
 return ws;
}
export function checkedPath(root: string, input: string): string {
 const target = resolve(root, input);
 const privatePath=dataDir.toLowerCase();
 if(target.toLowerCase()===privatePath||target.toLowerCase().startsWith(privatePath+sep))throw new Error('Hive data directory is private');
 if (target !== root && !target.startsWith(root + sep)) throw new Error('Path outside workspace');
 // Realpath the existing parent to stop symlink traversal for reads and writes.
 let probe = target;
 while (true) {
  try { probe = realpathSync(probe); break; } catch {
   const parent = resolve(probe, '..');
   if (parent === probe) throw new Error('Invalid path');
   probe = parent;
  }
 }
 if (probe !== root && !probe.startsWith(root + sep)) throw new Error('Symlink outside workspace');
 if(probe.toLowerCase()===privatePath||probe.toLowerCase().startsWith(privatePath+sep))throw new Error('Hive data directory is private');
 return target;
}

const writeTails=new Map<string,Promise<void>>();
export async function withWorkspaceWrite<T>(workspaceId:string,fn:()=>Promise<T>):Promise<T>{
 const previous=writeTails.get(workspaceId)||Promise.resolve();
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const tail=previous.catch(()=>{}).then(()=>gate);
 writeTails.set(workspaceId,tail);
 await previous.catch(()=>{});
 try{return await fn();}
 finally{release();if(writeTails.get(workspaceId)===tail)writeTails.delete(workspaceId);}
}
