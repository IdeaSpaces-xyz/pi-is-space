import { AGENT_TOOLS } from "./generated/agent-tools.js";
import type { CatalogRuntime } from "./catalog-runtime.js";

/** Installed facts, in the same short wording as the other agent surfaces. */
export function renderAgentSurfaceLine(runtime?: CatalogRuntime): string {
  const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 8);
  const built = AGENT_TOOLS.metadata.digest;
  const known = runtime?.available && runtime.version && runtime.digest;
  const changed = runtime?.comparisonComplete ? runtime.changed.filter(id => !id.endsWith(" (unverified)")).length : 0;
  const catalog = known && runtime.digest !== built
    ? `catalog differs (built ${short(built)}, running ${short(runtime.digest!)}); ${changed ? `${changed} tools changed; ` : ""}tools keep working. Update the plugin to match.`
    : `catalog ${short(built)}.`;
  return `Agent tools: Pi extension ${AGENT_TOOLS.metadata.wrapper.version} · CLI ${known ? runtime.version : "unknown (no answer in 1.2 s)"} · ${catalog}`;
}
