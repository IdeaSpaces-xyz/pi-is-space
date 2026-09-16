/**
 * Release e2e — the closure list through Pi's genuine extension runtime.
 *
 * Proves: is_release appends one session entry for a committed item and
 * refuses a modified one; at the compaction boundary a manual compaction is
 * cancelled while a released item is dirty, and the entry survives for the
 * next boundary. The summary the record joins is Pi's own (a model call), so
 * the record itself is proven in release.test.ts; here the wiring is real.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectReleases, RELEASE_ENTRY, type ReleaseItem } from "./release.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = 30_000;

let home: string;
let space: string;
let ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;
let runner: ExtensionRunner;
let sessionManager: SessionManager;
let tools: Map<string, { definition: { execute: Function } }>;
let toolCall = 0;
const savedEnv: Record<string, string | undefined> = {};

function env(): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", space, ...args], { encoding: "utf-8", env: env() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function call(name: string, params: Record<string, unknown>): Promise<{ text: string; error?: string }> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  try {
    const res = (await tool.definition.execute(`tc-${++toolCall}`, params, undefined, undefined, ctx)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
    return res.isError ? { text, error: text } : { text };
  } catch (err) {
    return { text: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function releases(): ReleaseItem[] {
  return sessionManager
    .getBranch()
    .filter((e) => e.type === "custom" && (e as { customType?: string }).customType === RELEASE_ENTRY)
    .map((e) => (e as { data: ReleaseItem }).data);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "is-pi-release-home-"));
  space = mkdtempSync(join(tmpdir(), "is-pi-release-space-"));
  for (const [k, v] of Object.entries(env())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Release Person"]);
  git(["config", "user.email", "person:release@ideaspaces"]);
  mkdirSync(join(space, "_agent"), { recursive: true });
  writeFileSync(join(space, "_agent", "agreement.md"), "---\nsummary: Agreement.\n---\n# Agreement\n");
  mkdirSync(join(space, "notes"), { recursive: true });
  writeFileSync(join(space, "notes", "decision.md"), "---\nname: Decision\nsummary: The boundary.\n---\n# Decision\n\nBody.\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);

  const agentDir = join(home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const result = await discoverAndLoadExtensions([join(ROOT, "src/index.ts")], space, agentDir);
  const ours = result.extensions.find((e: { tools: Map<string, unknown> }) => e.tools.has("is_release"));
  if (!ours) throw new Error("pi-is-space extension did not load or register is_release");
  tools = ours.tools;
  sessionManager = SessionManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, allowModelNetwork: false });
  runner = new ExtensionRunner(result.extensions, result.runtime, space, sessionManager, new ModelRegistry(modelRuntime));
  // Bind the one action a release needs — appending a custom session entry —
  // the way the real session binds it; everything else stays inert.
  const inert = () => {
    throw new Error("not bound in this test");
  };
  runner.bindCore(
    {
      sendMessage: inert,
      sendUserMessage: inert,
      appendEntry: (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      },
      setSessionName: inert,
      getSessionName: () => undefined,
      setLabel: inert,
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: inert,
      refreshTools: () => {},
      getCommands: () => [],
      setModel: inert as never,
      getThinkingLevel: () => "off" as never,
      setThinkingLevel: inert,
    },
    {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
    } as never,
  );
  ctx = runner.createContext();
}, T * 2);

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(space, { recursive: true, force: true });
});

function compactEvent(reason: "manual" | "threshold") {
  return {
    type: "session_before_compact" as const,
    preparation: {
      firstKeptEntryId: "keep",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 0,
      fileOps: { read: [], written: [], edited: [] },
      settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
    },
    branchEntries: sessionManager.getBranch(),
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as Parameters<ExtensionRunner["emit"]>[0];
}

describe("release through the real runtime", () => {
  test("is_release records a committed item with its sha and refuses a modified one", async () => {
    const blob = git(["rev-parse", "HEAD:notes/decision.md"]);
    const released = await call("is_release", { path: "notes/decision.md", to: "summary" });
    expect(released.error).toBeUndefined();
    expect(released.text).toContain(`Released notes/decision.md to summary (blob ${blob.slice(0, 12)})`);
    expect(releases()).toMatchObject([
      { position: "notes/decision.md", depth: "summary", revision: blob, disclosure: { name: "Decision", summary: "The boundary." } },
    ]);

    writeFileSync(join(space, "notes", "decision.md"), "# Decision\n\nEdited.\n");
    const refused = await call("is_release", { path: "notes/decision.md" });
    expect(refused.error).toContain("Capture it first");
    expect(releases()).toHaveLength(1);
  }, T);

  test("a manual compaction stops on a dirty released item; the entry waits for the next boundary", async () => {
    // notes/decision.md is still edited from the previous test.
    const manual = await runner.emit(compactEvent("manual"));
    expect(manual).toEqual({ cancel: true });
    expect(releases()).toHaveLength(1);

    // An unattended boundary while it is still dirty never stops; without a
    // model in this context the hook cannot join Pi's summary either way, so
    // it leaves compaction to Pi. Either way the entry is untouched.
    const dirtyThreshold = await runner.emit(compactEvent("threshold"));
    expect(dirtyThreshold).toBeUndefined();
    expect(releases()).toHaveLength(1);

    git(["checkout", "--", "notes/decision.md"]);
    const threshold = await runner.emit(compactEvent("threshold"));
    expect(threshold).toBeUndefined();
    expect(releases()).toHaveLength(1);
  }, T);

  test("a compaction that recorded the item consumes it; one that withheld it does not", async () => {
    const [item] = releases();
    const recorded = { type: "compaction", details: { [RELEASE_ENTRY]: [item] } };
    const withheld = { type: "compaction", details: { [RELEASE_ENTRY]: [] } };
    expect(collectReleases([...sessionManager.getBranch(), withheld]).map((i) => i.position)).toEqual(["notes/decision.md"]);
    expect(collectReleases([...sessionManager.getBranch(), recorded])).toEqual([]);
  }, T);
});
