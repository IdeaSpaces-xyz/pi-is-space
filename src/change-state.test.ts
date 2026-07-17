import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armingDecision,
  changeCachePath,
  clearPersistedChange,
  readPersistedChange,
  renderChangeLine,
  writePersistedChange,
  type PersistedChange,
} from "./change-state.js";

const NOW = 1_768_600_000_000;
const DAY = 86_400_000;

describe("changeCachePath", () => {
  it("lives under <home>/.ideaspaces/changes, never inside the project tree", () => {
    const p = changeCachePath("/home/u", "/work/my-space");
    expect(p.startsWith("/home/u/.ideaspaces/changes/")).toBe(true);
    expect(p.includes("/work/my-space")).toBe(false);
  });

  it("normalizes the project dir so equivalent paths key identically", () => {
    expect(changeCachePath("/home/u", "/work/a")).toBe(changeCachePath("/home/u", "/work/./a"));
  });

  // Cross-repo lock: mcp-server (write+read) and the Claude plugin hook (read)
  // assert this SAME golden value — the record is deliberately shared across
  // surfaces. Drift on any side fails loudly instead of a surface silently
  // going blind to (or splitting) the shared Change. The protocol-first epic's
  // slice 1 lifts the derivation into @ideaspaces/protocol and retires every
  // copy at once.
  it("matches the cross-repo golden value", () => {
    expect(changeCachePath("/home/u", "/work/a")).toBe(
      "/home/u/.ideaspaces/changes/d7f9747246691548",
    );
  });
});

describe("persisted-record round trip", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "is-pi-change-state-"));
    file = join(dir, "nested", "record"); // nested: write must mkdir -p
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const REC: PersistedChange = {
    change_id: "chg_token-bucket-a3f9",
    handle: "token bucket",
    opened_at: NOW - DAY,
    session_id: "pi-sess-123",
  };

  it("round-trips a full record, creating parent dirs", () => {
    writePersistedChange(file, REC);
    expect(readPersistedChange(file)).toEqual(REC);
  });

  it("returns undefined for an absent file, malformed JSON, or a bad Change-Id", () => {
    expect(readPersistedChange(file)).toBeUndefined();
    writeFileSync(join(dir, "broken"), "not json {");
    expect(readPersistedChange(join(dir, "broken"))).toBeUndefined();
    writeFileSync(join(dir, "badid"), JSON.stringify({ change_id: "CHG_NOPE", opened_at: 1 }));
    expect(readPersistedChange(join(dir, "badid"))).toBeUndefined();
  });

  it("clear removes an existing record and reports whether one existed", () => {
    writePersistedChange(file, REC);
    expect(clearPersistedChange(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(clearPersistedChange(file)).toBe(false);
  });
});

describe("armingDecision", () => {
  const rec = (session_id?: string): PersistedChange => ({
    change_id: "chg_x-1a2b",
    opened_at: 1,
    session_id,
  });

  it("none when nothing is persisted", () => {
    expect(armingDecision(undefined, "pi-1")).toBe("none");
  });

  it("arms silently ONLY for the same session (pi restart + resume)", () => {
    expect(armingDecision(rec("pi-1"), "pi-1")).toBe("arm");
  });

  it("surfaces for any other session — including the other surface's ids", () => {
    expect(armingDecision(rec("pi-1"), "pi-2")).toBe("surface");
    // A Claude Code session id can never equal a pi session id — cross-surface
    // records always surface, never silently stamp.
    expect(armingDecision(rec("6132b385-f9b4-4730-af69-ef8f0ddbe59c"), "pi-1")).toBe("surface");
  });

  it("surfaces when either side lacks a session id", () => {
    expect(armingDecision(rec(undefined), "pi-1")).toBe("surface");
    expect(armingDecision(rec("pi-1"), undefined)).toBe("surface");
  });
});

describe("renderChangeLine", () => {
  const rec = (over: Partial<PersistedChange> = {}): PersistedChange => ({
    change_id: "chg_x-1a2b",
    handle: "auth model",
    opened_at: NOW - 3 * DAY,
    session_id: "pi-1",
    ...over,
  });

  it("same session: states it is stamping, points at close", () => {
    const line = renderChangeLine(rec(), "pi-1", NOW);
    expect(line).toContain('Change open: chg_x-1a2b ("auth model") (this session, opened 3d ago)');
    expect(line).toContain("stamping every is_commit");
    expect(line).not.toContain("⚠");
  });

  it("different session or surface: warns, offers explicit resume or clear", () => {
    const line = renderChangeLine(rec(), "pi-2", NOW);
    expect(line).toContain("⚠ Change open: chg_x-1a2b");
    expect(line).toContain("opened 3d ago, previous session");
    expect(line).toContain('is_change_open({ id: "chg_x-1a2b" })');
    expect(line).not.toContain("stamping");
  });

  it("opened today reads as today; a future opened_at (clock skew) degrades cleanly", () => {
    expect(renderChangeLine(rec({ opened_at: NOW - DAY / 2 }), "pi-2", NOW)).toContain("opened today");
    expect(renderChangeLine(rec({ opened_at: NOW + DAY }), "pi-2", NOW)).toContain("opened in a previous session");
  });
});
