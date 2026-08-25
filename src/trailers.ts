import type { LocalEffectTrailers, Op } from "@ideaspaces/protocol";

const CANONICAL_CO_AUTHOR = /^[^<>\r\n]+ <agent:[^<>\s]+@ideaspaces>$/;
const AGENT_PRINCIPAL = /^agent:([^<>\s@]+)(?:@ideaspaces)?$/;

/** Preserve Pi's established principal resolution without platform lookup. */
export function resolvePiAgentPrincipal(
  agentIdEnv: string | undefined,
  identityEmail: string,
): string | undefined {
  const override = agentIdEnv?.trim();
  if (override) {
    const bare = override.replace(/^agent:/, "").replace(/@.*$/, "").trim();
    return bare ? `agent:${bare}@ideaspaces` : undefined;
  }
  const person = /^person:(.+)@ideaspaces$/.exec(identityEmail.trim());
  return person ? `agent:${person[1]}-pi@ideaspaces` : undefined;
}

/** Upgrade Pi's agent principal spelling to the protocol trailer form. */
export function canonicalPiCoAuthor(principal: string): string {
  if (CANONICAL_CO_AUTHOR.test(principal)) return principal;
  const agent = AGENT_PRINCIPAL.exec(principal.trim());
  if (!agent) {
    throw new Error(
      `Invalid Pi agent principal ${JSON.stringify(principal)}. Expected agent:<id>.`,
    );
  }
  const id = agent[1];
  return `${id} <agent:${id}@ideaspaces>`;
}

export interface PiCommitContext {
  changeId?: string;
  principal?: string;
  sessionId?: string;
}

/** Build structured protocol trailers without a CLI argv translation. */
export function buildPiCommitTrailers(
  op: Op | undefined,
  context: PiCommitContext,
): LocalEffectTrailers {
  return {
    ...(op === undefined ? {} : { op }),
    ...(context.changeId === undefined ? {} : { change_id: context.changeId }),
    ...(context.sessionId === undefined ? {} : { conversation: context.sessionId }),
    ...(context.principal === undefined
      ? {}
      : { co_authored_by: [canonicalPiCoAuthor(context.principal)] }),
  };
}
