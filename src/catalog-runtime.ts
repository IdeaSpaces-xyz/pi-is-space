import { AGENT_TOOLS } from './generated/agent-tools.js';
export type CatalogRuntime = { available:boolean; version?:string; digest?:string; changed:string[]; note:string };
type Runner = (args:string[])=>Promise<{out:string;err:string;code:number}>;
export async function inspectCatalog(run:Runner):Promise<CatalogRuntime> {
  try {
    const result=await run(['capabilities','--json']);
    const data=JSON.parse(result.out);
    if(result.code!==0 || typeof data.cli?.version!=='string' || typeof data.digest!=='string') throw new Error('CLI does not report build metadata');
    const changed:string[]=[];
    if(data.digest!==AGENT_TOOLS.metadata.digest) {
      // A mismatch is reported, not refused. Ask only for this host's exposed entries.
      for(const entry of AGENT_TOOLS.entries) {
        const response=await run(['capabilities',entry.id,'--json']);
        try { if(JSON.stringify(JSON.parse(response.out).entry)!==JSON.stringify(entry)) changed.push(entry.id); }
        catch { changed.push(`${entry.id} (unavailable)`); }
      }
    }
    return {available:true,version:data.cli.version,digest:data.digest,changed,note:data.digest===AGENT_TOOLS.metadata.digest?'Installed CLI catalog matches generated contracts.':`Catalog drift; changed exposed entries: ${changed.join(', ') || 'none (other entries changed)'}. Tools keep running.`};
  } catch(error) { return {available:false,changed:[],note:`Installed CLI catalog unavailable: ${error instanceof Error?error.message:String(error)}. Version and digest are unknown.`}; }
}
export function belowRequired(version:string|undefined, requirements:readonly string[]):boolean {
  const v=version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if(!v) return false; // Unknown is reported, never silently called zero or old.
  return requirements.some(r=>{
    const required=r.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
    if(!required) throw new Error(`Unsupported catalog version requirement ${r}`);
    for(let i=1;i<=3;i++) { if(+v[i]<+required[i]) return true; if(+v[i]>+required[i]) return false; }
    return false;
  });
}
