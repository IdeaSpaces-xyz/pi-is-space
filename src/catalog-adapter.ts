import { AGENT_TOOLS } from './generated/agent-tools.js';

/** Values are whole argv elements, even when a message starts with --. */
export function catalogArguments(args: string[]): string[] {
  const start = args[0] === '--json' ? 1 : 0;
  const entry = AGENT_TOOLS.entries.find(e => 'cli' in e && e.cli.argv.every((word,i) => args[start+i] === word));
  if (!entry || !('cli' in entry)) return args;
  const flags = Object.values(entry.cli.flags) as Array<{flag:string;boolean?:string;aliases?:readonly string[]}>;
  const valued = new Set(flags.filter(f=>!f.boolean).flatMap(f=>[f.flag,...(f.aliases??[])]));
  const out: string[] = [];
  for(let i=0;i<args.length;i++) {
    if(valued.has(args[i]) && i+1<args.length) out.push(`${args[i]}=${args[++i]}`);
    else out.push(args[i]);
  }
  return out;
}
