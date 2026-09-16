/**
 * Release — the closure list, executed at the compaction boundary.
 *
 * Releasing an item lets its detail fade behind the focal point: the item
 * closes down the Map ladder (full → summary → name) and its raw turns stay in
 * the session log. History is append-only and cached, so a release never edits
 * the window when called. It appends one `is_release` entry to the session;
 * the list executes when Pi compacts, where this module supplies the record —
 * the compaction summary plus a map-note of every released member at its new
 * rung and sha. One record, not two.
 *
 * Never-evict-dirty: an item whose worktree bytes are not the bytes at HEAD has
 * no sha a Map can name. It is refused with a capture proposal instead. The
 * check runs twice — at release, and again at the boundary.
 */

import { join } from "node:path";
import {
  assembleContentLook,
  gitState,
  pathRevision,
  type ContractSource,
  type MapDisclosure,
} from "@ideaspaces/protocol";
import {
  canonicalRepoRoot,
  localEffectCapabilities,
  toPortableRepoPath,
} from "./local-effects-adapter.js";

export const RELEASE_ENTRY = "is_release";
export type ReleaseRung = "name" | "summary";

export interface ReleaseItem {
  /** The address as the caller gave it. */
  address: string;
  repoRoot: string;
  /** Portable repository-relative position. */
  position: string;
  depth: ReleaseRung;
  disclosure: MapDisclosure;
  /** Git blob id of the item at HEAD when released — the sha the Map names. */
  revision: string;
  /** Repository HEAD when released. */
  commit: string;
  released_at: number;
}

export type ReleaseOutcome =
  | { ok: true; item: ReleaseItem }
  | { ok: false; text: string };

/** Minimal shape of a session entry this module reads; Pi's SessionEntry satisfies it. */
export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

const CAPTURE_PROPOSAL =
  "Release refused: the content differs from HEAD, so no sha can name it. Capture it first — is_write, then is_commit — and release again.";

/**
 * Verify one address and read it at the target rung. Refuses an untracked or
 * modified item; nothing is written.
 */
export async function prepareRelease(input: {
  address: string;
  to?: ReleaseRung;
  cwd: string;
  contract?: ContractSource;
}): Promise<ReleaseOutcome> {
  const depth: ReleaseRung = input.to ?? "summary";
  let repoRoot: string;
  try {
    repoRoot = await canonicalRepoRoot(input.cwd, localEffectCapabilities.git);
  } catch (error) {
    return { ok: false, text: `Release needs a Git worktree: ${error instanceof Error ? error.message : String(error)}` };
  }
  const position = await toPortableRepoPath(input.address, repoRoot, input.cwd).catch(() => null);
  if (!position) return { ok: false, text: `Release refused: ${input.address} is outside the repository root.` };

  const revision = await pathRevision(
    repoRoot,
    position,
    localEffectCapabilities.git,
    localEffectCapabilities.filesystem,
  );
  if (revision.status === "error") return { ok: false, text: `Release refused: ${revision.message}` };
  const { worktree, head } = revision.revision;
  if (worktree === null) return { ok: false, text: `Release refused: ${position} does not exist.` };
  if (head === null || worktree !== head) return { ok: false, text: CAPTURE_PROPOSAL };

  const request = { position: join(repoRoot, position), depth, ...(input.contract ? { contractSource: input.contract } : {}) };
  let looked = await assembleContentLook(request);
  if (looked?.status === "contract_choice_required" && !input.contract) {
    looked = await assembleContentLook({ ...request, contractSource: "agreement" });
  }
  if (!looked) return { ok: false, text: `Release refused: ${position} is not a Content position.` };
  if (looked.status !== "ok") return { ok: false, text: `Release refused: ${looked.status}.` };

  const state = await gitState(repoRoot);
  if (!state.headSha) return { ok: false, text: CAPTURE_PROPOSAL };
  return {
    ok: true,
    item: {
      address: input.address,
      repoRoot,
      position,
      depth,
      disclosure: looked.target.member.disclosure ?? { name: looked.target.name },
      revision: head,
      commit: state.headSha,
      released_at: Date.now(),
    },
  };
}

/**
 * The closure list: `is_release` entries on the branch since the last
 * compaction, latest per position, in first-release order. Entries before a
 * compaction already executed in that compaction's record.
 */
export function collectReleases(entries: readonly BranchEntry[]): ReleaseItem[] {
  let start = 0;
  entries.forEach((entry, index) => {
    if (entry.type === "compaction") start = index + 1;
  });
  const byPosition = new Map<string, ReleaseItem>();
  for (const entry of entries.slice(start)) {
    if (entry.type !== "custom" || entry.customType !== RELEASE_ENTRY) continue;
    const item = entry.data as ReleaseItem | undefined;
    if (!item?.position || !item.repoRoot) continue;
    const key = `${item.repoRoot}\0${item.position}`;
    // Latest wins but keeps the first release's place in the order.
    const previous = byPosition.get(key);
    byPosition.set(key, previous ? { ...item, released_at: previous.released_at } : item);
  }
  return [...byPosition.values()].sort((a, b) => a.released_at - b.released_at);
}

export interface VerifiedReleases {
  ready: ReleaseItem[];
  /** Items whose bytes moved since release and are not at HEAD now. */
  dirty: ReleaseItem[];
}

/** Re-run never-evict-dirty at the boundary; refresh the sha for items committed since. */
export async function verifyReleases(
  items: readonly ReleaseItem[],
  revisionOf: (repoRoot: string, position: string) => Promise<{ worktree: string | null; head: string | null }> = defaultRevision,
): Promise<VerifiedReleases> {
  const ready: ReleaseItem[] = [];
  const dirty: ReleaseItem[] = [];
  for (const item of items) {
    const { worktree, head } = await revisionOf(item.repoRoot, item.position);
    if (worktree !== null && head !== null && worktree === head) ready.push({ ...item, revision: head });
    else dirty.push(item);
  }
  return { ready, dirty };
}

async function defaultRevision(repoRoot: string, position: string) {
  const read = await pathRevision(repoRoot, position, localEffectCapabilities.git, localEffectCapabilities.filesystem);
  if (read.status === "error") return { worktree: null, head: null };
  return { worktree: read.revision.worktree, head: read.revision.head };
}

/** The record: every released member at its rung and sha, grouped by root. */
export function renderReleaseRecord(ready: readonly ReleaseItem[], dirty: readonly ReleaseItem[]): string {
  const lines = ["[IdeaSpaces Released]"];
  lines.push(
    "Released from the active window at this compaction. Raw turns remain in the session log; re-read any item in full with is_look.",
  );
  const roots = new Map<string, ReleaseItem[]>();
  for (const item of ready) {
    const group = roots.get(item.repoRoot) ?? [];
    group.push(item);
    roots.set(item.repoRoot, group);
  }
  for (const [root, items] of roots) {
    lines.push("", `Root: ${root}`);
    for (const item of items) {
      const summary = item.depth === "summary" && item.disclosure.summary ? ` — ${item.disclosure.summary}` : "";
      lines.push(`  - ${item.position} (${item.depth}, blob ${item.revision.slice(0, 12)}): ${item.disclosure.name ?? item.position}${summary}`);
    }
  }
  if (dirty.length) {
    lines.push("", "Not released — content differs from HEAD, capture it first:");
    for (const item of dirty) lines.push(`  - ${item.position}`);
  }
  return lines.join("\n");
}

export type CompactionPlan =
  | { kind: "default" }
  | { kind: "cancel"; message: string }
  | { kind: "record"; ready: ReleaseItem[]; dirty: ReleaseItem[]; record: string };

/**
 * What the boundary does with the closure list. A manual compaction stops on a
 * dirty item — that is the agreement gate, and the person is present to
 * capture. Threshold and overflow compactions must not be stopped; the dirty
 * item stays un-released and is named in the record.
 */
export async function planCompaction(
  reason: "manual" | "threshold" | "overflow",
  entries: readonly BranchEntry[],
  verify: (items: readonly ReleaseItem[]) => Promise<VerifiedReleases> = verifyReleases,
): Promise<CompactionPlan> {
  const items = collectReleases(entries);
  if (!items.length) return { kind: "default" };
  const { ready, dirty } = await verify(items);
  if (dirty.length && reason === "manual") {
    return {
      kind: "cancel",
      message: `Compaction stopped: ${dirty.map((d) => d.position).join(", ")} differ from HEAD. Capture them (is_write, is_commit) or release them again after, then /compact.`,
    };
  }
  return { kind: "record", ready, dirty, record: renderReleaseRecord(ready, dirty) };
}
