import { AGENT_TOOLS } from "./generated/agent-tools.js";

const valuedFlags = new Set(
  AGENT_TOOLS.entries.flatMap((entry) =>
    "cli" in entry
      ? Object.values(entry.cli.flags).flatMap((raw) => {
          const flag = raw as {
            flag: string;
            boolean?: string;
            aliases?: readonly string[];
          };
          return flag.boolean ? [] : [flag.flag, ...(flag.aliases ?? [])];
        })
      : [],
  ),
);

/** Encode at the builder's exact option position, never scan positional values. */
export function cliOption(flag: string, value: string | number): string {
  if (!valuedFlags.has(flag))
    throw new Error(`Option is not in the generated CLI contract: ${flag}`);
  return `${flag}=${value}`;
}
