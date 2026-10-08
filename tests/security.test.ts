import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {sandboxCommand} from '../src/sandbox';
import {checkedPath} from '../src/workspace';

const workspace={id:'fixture',name:'Fixture',path:join(process.cwd(),'evals/hive-sandbox')};

test('workspace path checks reject parent traversal',()=>{
 expect(()=>checkedPath(workspace.path,'../../HIVE_PLAN.md')).toThrow();
 expect(checkedPath(workspace.path,'math.js')).toBe(join(workspace.path,'math.js'));
 expect(()=>checkedPath(join(process.cwd()),'.hive-data/access-token')).toThrow();
});

test('sandbox permits a local test and denies credentials and network',async()=>{
 const result=await sandboxCommand(workspace,
  'node -e "console.log(42)"; test -r /Users/zaaac/.config/gh/hosts.yml; echo home:$?; test -r /Volumes/Data/Code/agentswarm/.hive-data/access-token; echo hive:$?; curl -sS --max-time 2 http://127.0.0.1:4317/ >/dev/null 2>&1; echo network:$?');
 expect(result.stdout).toContain('42');
 expect(result.stdout).toContain('home:1');
 expect(result.stdout).toContain('hive:1');
 expect(result.stdout).toContain('network:7');
});
