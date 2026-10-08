import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type LeaseKind='workstation-write'|'desktop'|'browser'|'xcode-build'|'simulator';
export type HealthReport={available:boolean;reason?:string};
export type AgentContext={agentId:string;channelId:string};
export interface Toolpack {
 id:string;
 tools(ctx:AgentContext):ToolDefinition[];
 leases?:LeaseKind[];
 healthcheck():Promise<HealthReport>;
 guidance?:string;
}

export function loadTools(packs:Toolpack[],ctx:AgentContext,grants:string[]):ToolDefinition[]{
 const byName=new Map<string,ToolDefinition>();
 for(const pack of packs) for(const tool of pack.tools(ctx)) {
  if(byName.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
  byName.set(tool.name,tool);
 }
 return [...byName.values()].filter(tool=>grants.includes(tool.name));
}
