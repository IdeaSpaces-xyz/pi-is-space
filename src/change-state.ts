/**
 * Change persistence + rendering — pi's mirror of the shared record.
 *
 * The open Change used to live only in extension memory: a pi restart silently
 * dropped it, commits stopped carrying the trailer, and the decision's arc
 * broke without anyone being told. This module persists the open Change to the
 * SAME user-level record the MCP server writes (mcp-server `change-state.ts`),
 * which makes persistence **cross-surface**: a Change opened in Claude Code
 * surfaces in pi started in the same directory, and vice versa.
 *
 * The load-bearing rule is {@link armingDecision}: a persisted Change re-arms
 * SILENTLY only for the session that opened it (pi restart + resume of the
 * same session). Any other session — later, another window, or the *other
 * surface* — gets it SURFACED, never auto-stamped: a pi session id never
 * equals a Claude session id, so cross-surface arming is impossible by
 * construction. Resume stays explicit via is_change_open({ id }).
 *
 * Cross-repo lock: the cache-path derivation exists in mcp-server
 * (write+read), the Claude plugin hook (read), and here — all asserting the
 * same golden value. The protocol-first epic's slice 1 lifts the derivation
 * into @ideaspaces/protocol and retires every copy at once.
 */

import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** The protocol Change-Id shape (schema/trailers.md). Validated on every read
 * and resume so bad state can never arm and reach a commit. */
export const CHANGE_ID_SHAPE = /^chg_[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Where the open Change is cached for a given session-start dir. Same
 * derivation as the session/id caches (user-level, hashed key — no footprint
 * in visited repos), under `changes/`. Keyed by the session's start cwd —
 * pi's analog of CLAUDE_PROJECT_DIR — never by a per-call cwd override.
 */
export function changeCachePath(homeDir: string, projectDir: string): string {
  const key = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(homeDir, ".ideaspaces", "changes", key);
}

export interface PersistedChange {
  change_id: string;
  /** The decision handle the Change was minted from, when known. */
  handle?: string;
  /** Epoch ms when the Change was opened — feeds "opened Nd ago" surfacing. */
  opened_at: number;
  /** The session that opened it — the silent-re-arm discriminator. */
  session_id?: string;
}

/** Read and validate the persisted record. Absent, unreadable, or malformed →
 * undefined (the cache fails open — no persisted Change). */
export function readPersistedChange(file: string): PersistedChange | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.change_id !== "string" || !CHANGE_ID_SHAPE.test(rec.change_id)) return undefined;
    return {
      change_id: rec.change_id,
      handle: typeof rec.handle === "string" ? rec.handle : undefined,
      opened_at: typeof rec.opened_at === "number" ? rec.opened_at : 0,
      session_id: typeof rec.session_id === "string" ? rec.session_id : undefined,
    };
  } catch {
    return undefined;
  }
}

export function writePersistedChange(file: string, rec: PersistedChange): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec) + "\n");
}

/** Remove the persisted record. Returns whether one existed. Best-effort —
 * a failed unlink reports false rather than throwing. */
export function clearPersistedChange(file: string): boolean {
  try {
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export type ArmingDecision = "arm" | "surface" | "none";

/**
 * May a persisted Change re-arm silently?
 *
 * - `"arm"` — same session that opened it (pi restart + resume): restore
 *   silently; this is the bug fix.
 * - `"surface"` — any other or unknown session, including the other surface:
 *   show it, require an explicit is_change_open({ id }).
 * - `"none"` — nothing persisted.
 *
 * Conservative on missing identity: if either side lacks a session id, never
 * arm — a Change without provenance surfaces instead of stamping.
 */
export function armingDecision(
  rec: PersistedChange | undefined,
  currentSessionId: string | undefined,
): ArmingDecision {
  if (!rec) return "none";
  if (rec.session_id && currentSessionId && rec.session_id === currentSessionId) return "arm";
  return "surface";
}

/** "today", "1d ago", "3d ago" — coarse on purpose; the id matters, not the clock. */
function age(openedAt: number | undefined, now: number): string | undefined {
  if (!openedAt || openedAt > now) return undefined;
  const days = Math.floor((now - openedAt) / 86_400_000);
  return days < 1 ? "today" : `${days}d ago`;
}

/**
 * One awareness line, phrased by session provenance — display-only (arming is
 * {@link armingDecision}'s job). Same phrasing as the Claude plugin's
 * SessionStart line so the two surfaces describe one Change identically.
 */
export function renderChangeLine(
  rec: PersistedChange,
  currentSessionId: string | undefined,
  now: number,
): string {
  const opened = age(rec.opened_at, now);
  const handle = rec.handle ? ` ("${rec.handle}")` : "";
  if (rec.session_id && currentSessionId && rec.session_id === currentSessionId) {
    return (
      `Change open: ${rec.change_id}${handle} (this session${opened ? `, opened ${opened}` : ""}) — ` +
      `stamping every is_commit; close with is_change_close when the decision lands.`
    );
  }
  return (
    `⚠ Change open: ${rec.change_id}${handle} (opened ${opened ?? "in a previous session"}${opened ? ", previous session" : ""}) — ` +
    `resume with is_change_open({ id: "${rec.change_id}" }) or clear with is_change_close.`
  );
}
