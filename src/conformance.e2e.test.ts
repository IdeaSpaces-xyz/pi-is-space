/**
 * Conformance e2e — proves pi-is-space's real write paths against the protocol.
 *
 * The extension is loaded through Pi's genuine loader (discoverAndLoadExtensions
 * → jiti) and its tools execute with an ExtensionRunner-built context — real
 * SessionManager (in-memory), real ctx.cwd — into a temp space scaffolded by
 * the dependency-installed CLI. Results are validated with
 * @ideaspaces/protocol: validateSpace over the tree, parseTrailers +
 * CHANGE_ID_PATTERN over the commits produced.
 *
 * This is the Pi half of the protocol's "prove conformance through the real
 * write paths" item (the Claude plugin half is claude-code-plugin#46). It
 * covers write-path conformance through the real runtime plumbing; Pi UI
 * commands and event guards are outside its scope. Everything runs under a
 * sandboxed $HOME.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AuthStorage,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  CHANGE_ID_PATTERN,
  isValidChangeId,
  parseTrailers,
  validateSpace,
} from "@ideaspaces/protocol";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");

const T = 30_000;

let home: string;
let space: string;
let ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;
let sessionManager: SessionManager;
let tools: Map<string, { definition: { execute: Function } }>;
let toolCall = 0;
const savedEnv: Record<string, string | undefined> = {};

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function sh(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", env: baseEnv() });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const git = (args: string[]) => sh("git", ["-C", space, ...args], space);

/** Execute a real extension tool with the runner-built context. */
async function call(
  name: string,
  params: Record<string, unknown>,
): Promise<{ text: string; error?: string }> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  try {
    const res = (await tool.definition.execute(`tc-${++toolCall}`, params, undefined, undefined, ctx)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = res.content?.map((c) => c.text ?? "").join("") ?? "";
    if (res.isError) return { text, error: text };
    return { text };
  } catch (err) {
    return { text: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function lastCommit(): { author: string; message: string } {
  return {
    author: git(["log", "-1", "--format=%an <%ae>"]),
    message: git(["log", "-1", "--format=%B"]),
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "is-pi-conformance-home-"));
  space = mkdtempSync(join(tmpdir(), "is-pi-conformance-space-"));

  // The extension spawns the CLI with inherited process env — sandbox HOME for
  // the whole suite so no real credentials, git config, or session state leak.
  for (const [k, v] of Object.entries(baseEnv())) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  // Person identity in the sandbox's GLOBAL config before create runs — on an
  // identity-less machine create fails midway ("empty ident name"); see the
  // plugin conformance suite for the same guard.
  sh("git", ["config", "--global", "user.name", "Test Person"], space);
  sh("git", ["config", "--global", "user.email", "person:tester@ideaspaces"], space);

  // Real scaffold path: create inits git and commits the seed contract.
  sh("node", [CLI, "create", "--yes"], space);

  // Load the extension through Pi's genuine loader; execute with a
  // runner-built context. agentDir points into the sandbox so no user-global
  // extensions are discovered alongside ours.
  const agentDir = join(home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const result = await discoverAndLoadExtensions([join(ROOT, "src/index.ts")], space, agentDir);
  const ours = result.extensions.find((e: { tools: Map<string, unknown> }) => e.tools.has("is_write"));
  if (!ours) throw new Error("pi-is-space extension did not load or register is_write");
  tools = ours.tools;

  sessionManager = SessionManager.inMemory();
  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    space,
    sessionManager,
    ModelRegistry.create(AuthStorage.create(join(home, "auth.json"))),
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

describe("write → commit conformance", () => {
  test("is_write produces a staged Note with Layer-1 frontmatter and a content sha", { timeout: T }, async () => {
    const r = await call("is_write", {
      path: "notes/first-finding.md",
      content: "# First finding\n\nThe Pi write path works end to end.\n",
      name: "First finding",
      summary: "Pi conformance harness proves the write path end to end.",
    });
    expect(r.error, r.error).toBeUndefined();
    expect(r.text).toMatch(/[0-9a-f]{40}/);

    const raw = readFileSync(join(space, "notes/first-finding.md"), "utf-8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("name: First finding");
    expect(git(["diff", "--cached", "--name-only"])).toContain("notes/first-finding.md");
  });

  test("is_commit commits path-scoped, authored by the person, with agent + Conversation trailers from the real session", { timeout: T }, async () => {
    const r = await call("is_commit", {
      message: "Add first finding",
      paths: ["notes/first-finding.md"],
      op: "create",
    });
    expect(r.error, r.error).toBeUndefined();

    const { author, message } = lastCommit();
    expect(author).toBe("Test Person <person:tester@ideaspaces>");

    const trailers = parseTrailers(message);
    expect(trailers.op).toBe("create");
    expect(trailers.coAuthoredBy?.join()).toMatch(/agent:[a-z0-9._-]+/i);
    // The Conversation trailer carries the REAL session id from Pi's runtime —
    // ctx.sessionManager.getSessionId() — not a bridged cache file.
    const sessionId = sessionManager.getSessionId();
    if (sessionId) {
      expect(trailers.conversation).toBe(sessionId);
    } else {
      expect(trailers.conversation).toBeUndefined();
    }
    expect(trailers.changeId).toBeUndefined();
  });

  test("is_commit never sweeps unrelated staged work", { timeout: T }, async () => {
    writeFileSync(join(space, "unrelated.md"), "# Someone else's staged file\n");
    git(["add", "unrelated.md"]);

    await call("is_write", {
      path: "notes/second.md",
      content: "# Second\n\nBody.\n",
      name: "Second",
      summary: "Second note.",
    });
    const r = await call("is_commit", { message: "Add second note", paths: ["notes/second.md"] });
    expect(r.error, r.error).toBeUndefined();

    expect(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("notes/second.md");
    expect(git(["diff", "--cached", "--name-only"])).toBe("unrelated.md");
    git(["restore", "--staged", "unrelated.md"]);
    rmSync(join(space, "unrelated.md"));
  });
});

describe("Change lifecycle", () => {
  let changeId: string;

  test("is_change_open mints a conformant Change-Id", { timeout: T }, async () => {
    const r = await call("is_change_open", { handle: "pi conformance run" });
    expect(r.error, r.error).toBeUndefined();
    const m = r.text.match(/chg_[a-z0-9-]+/);
    expect(m, `no Change-Id in: ${r.text}`).toBeTruthy();
    changeId = m![0];
    expect(changeId).toMatch(CHANGE_ID_PATTERN);
    expect(isValidChangeId(changeId)).toBe(true);
  });

  test("open Change stamps every commit; close stops it", { timeout: T }, async () => {
    await call("is_write", {
      path: "notes/third.md",
      content: "# Third\n\nBody.\n",
      name: "Third",
      summary: "Third note.",
    });
    await call("is_commit", { message: "Add third note", paths: ["notes/third.md"], op: "update" });
    expect(parseTrailers(lastCommit().message).changeId).toBe(changeId);

    await call("is_change_close", {});
    await call("is_write", {
      path: "notes/fourth.md",
      content: "# Fourth\n\nBody.\n",
      name: "Fourth",
      summary: "Fourth note.",
    });
    await call("is_commit", { message: "Add fourth note", paths: ["notes/fourth.md"] });
    expect(parseTrailers(lastCommit().message).changeId).toBeUndefined();
  });
});

describe("optimistic concurrency", () => {
  test("is_write refuses a stale if_match and accepts the current sha", { timeout: T }, async () => {
    const stale = await call("is_write", {
      path: "notes/first-finding.md",
      content: "# Overwrite attempt\n",
      name: "First finding",
      summary: "Stale update.",
      if_match: "0".repeat(40),
    });
    expect(stale.error, "stale if_match must refuse").toBeTruthy();

    const status = await call("is_status", { path: "notes/first-finding.md" });
    const sha = status.text.match(/[0-9a-f]{40}/)?.[0];
    expect(sha, `no sha in is_status: ${status.text}`).toBeTruthy();
    const ok = await call("is_write", {
      path: "notes/first-finding.md",
      content: "# First finding\n\nRefined body.\n",
      name: "First finding",
      summary: "Pi conformance harness proves the write path end to end.",
      if_match: sha,
    });
    expect(ok.error, ok.error).toBeUndefined();
  });
});

describe("move / delete write paths", () => {
  test("a git-mv'd Note commits path-scoped with Op: move", { timeout: T }, async () => {
    await call("is_write", {
      path: "notes/mover.md",
      content: "# Mover\n\nBody.\n",
      name: "Mover",
      summary: "Note that gets moved.",
    });
    await call("is_commit", { message: "Add mover", paths: ["notes/mover.md"] });

    git(["mv", "notes/mover.md", "notes/moved.md"]);
    const r = await call("is_commit", {
      message: "Move mover to moved",
      paths: ["notes/mover.md", "notes/moved.md"],
      op: "move",
    });
    expect(r.error, r.error).toBeUndefined();

    expect(parseTrailers(lastCommit().message).op).toBe("move");
    expect(git(["show", "--name-status", "--format=", "-M", "HEAD"]).trim()).toBe(
      "R100\tnotes/mover.md\tnotes/moved.md",
    );
  });

  test("a deleted Note commits path-scoped with Op: delete", { timeout: T }, async () => {
    await call("is_write", {
      path: "notes/doomed.md",
      content: "# Doomed\n\nBody.\n",
      name: "Doomed",
      summary: "Note that gets deleted.",
    });
    await call("is_commit", { message: "Add doomed", paths: ["notes/doomed.md"] });

    git(["rm", "-q", "notes/doomed.md"]);
    const r = await call("is_commit", {
      message: "Delete doomed",
      paths: ["notes/doomed.md"],
      op: "delete",
    });
    expect(r.error, r.error).toBeUndefined();

    expect(parseTrailers(lastCommit().message).op).toBe("delete");
    expect(git(["show", "--name-status", "--format=", "HEAD"]).trim()).toBe("D\tnotes/doomed.md");
  });
});

describe("space conformance", () => {
  test("everything the write path produced validates against the protocol", { timeout: T }, async () => {
    const report = await validateSpace(space);
    const errors = report.issues.filter((i) => i.level === "error");
    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.notesChecked).toBeGreaterThanOrEqual(5);
  });
});
