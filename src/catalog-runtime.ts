import { AGENT_TOOLS } from "./generated/agent-tools.js";
export type CatalogRuntime = {
  available: boolean;
  version?: string;
  digest?: string;
  changed: string[];
  note: string;
};
type Runner = (
  args: string[],
  signal: AbortSignal,
) => Promise<{ out: string; err: string; code: number }>;

/** One deadline bounds all metadata work, including a drifting/hung CLI. */
export async function inspectCatalog(
  run: Runner,
  { deadlineMs = 1200 } = {},
): Promise<CatalogRuntime> {
  const controller = new AbortController();
  let observed: CatalogRuntime = {
    available: false,
    changed: [],
    note: "Installed CLI version and digest are unknown.",
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    try {
      const result = await run(["capabilities", "--json"], controller.signal);
      const data = JSON.parse(result.out);
      if (
        result.code !== 0 ||
        typeof data.cli?.version !== "string" ||
        typeof data.digest !== "string"
      )
        throw new Error("CLI does not report build metadata");
      observed = {
        available: true,
        version: data.cli.version,
        digest: data.digest,
        changed: [],
        note: "Installed CLI catalog matches generated contracts.",
      };
      if (data.digest === AGENT_TOOLS.metadata.digest) return observed;
      const pending = [...AGENT_TOOLS.entries];
      const changed: string[] = [];
      // At most three probes, under the same deadline. Completion order never
      // affects the report's order or prompt-cache bytes.
      await Promise.all(
        Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (pending.length && !controller.signal.aborted) {
            const entry = pending.shift()!;
            try {
              const response = await run(
                ["capabilities", entry.id, "--json"],
                controller.signal,
              );
              if (
                JSON.stringify(JSON.parse(response.out).entry) !==
                JSON.stringify(entry)
              )
                changed.push(entry.id);
            } catch {
              changed.push(`${entry.id} (unverified)`);
            }
          }
        }),
      );
      if (controller.signal.aborted) return observed;
      changed.sort();
      observed = {
        ...observed,
        changed,
        note: `Catalog drift; changed or unverified exposed entries: ${changed.join(", ") || "none (other entries changed)"}. Tools keep running.`,
      };
      return observed;
    } catch (error) {
      return {
        ...observed,
        note: `Installed CLI catalog unavailable: ${error instanceof Error ? error.message : String(error)}. Unknown is not zero.`,
      };
    }
  })();
  const deadline = new Promise<CatalogRuntime>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ...observed,
        note: `Catalog metadata deadline (${deadlineMs}ms); entry comparison incomplete. Generated entries: ${AGENT_TOOLS.entries.map((e) => e.id).join(", ")}. Tools keep running; missing observations are unknown.`,
      });
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
export function belowRequired(
  version: string | undefined,
  requirements: readonly string[],
): boolean {
  const v = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!v) return false;
  return requirements.some((r) => {
    // The generator validates this dialect before a contract reaches runtime.
    const required = r.match(/^>=(\d+)\.(\d+)\.(\d+)$/)!;
    for (let i = 1; i <= 3; i++) {
      if (+v[i] < +required[i]) return true;
      if (+v[i] > +required[i]) return false;
    }
    return false;
  });
}
