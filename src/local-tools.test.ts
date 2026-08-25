import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LocalEffectCapabilities,
  LocalGitResult,
  LocalGitRunner,
} from "@ideaspaces/protocol";
import { nodeLocalEffectFileSystem } from "@ideaspaces/protocol/local-effects";
import { SessionCaptureLedger } from "./capture-ledger.js";
import type { LocalToolDependencies } from "./local-tools.js";
import { runLocalCommit, runLocalStatus, runLocalWrite } from "./local-tools.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-local-tools-")));
  cleanups.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test Person");
  git(root, "config", "user.email", "person:tester@ideaspaces");
  writeFileSync(join(root, "seed.md"), "# Seed\n");
  git(root, "add", "seed.md");
  git(root, "commit", "-qm", "seed");
  return root;
}

function runner(
  fault?: (args: readonly string[]) => LocalGitResult | undefined,
): LocalGitRunner {
  return async (root, args) => {
    const injected = fault?.(args);
    if (injected) return injected;
    return new Promise((done) => {
      const proc = spawn("git", [...args], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      proc.on("close", (code) => done({ ok: code === 0, stdout, stderr, code }));
      proc.on("error", (error) =>
        done({ ok: false, stdout: "", stderr: error.message, code: null }),
      );
    });
  };
}

function capabilities(gitRunner: LocalGitRunner = runner()): LocalEffectCapabilities {
  return { git: gitRunner, filesystem: nodeLocalEffectFileSystem };
}

function deps(
  root: string,
  ledger = new SessionCaptureLedger(),
  effectCapabilities = capabilities(),
): LocalToolDependencies {
  return {
    capabilities: effectCapabilities,
    ledger,
    sessionId: () => "sess-test",
    changeId: () => "chg_pf3b-test",
    agentIdEnv: "test-pi",
    processCwd: root,
  };
}

function json(result: { text: string }): any {
  return JSON.parse(result.text);
}

describe("in-process Pi local tools", () => {
  it("writes, tracks, refines, and reports full revisions without a CLI", async () => {
    const root = makeRepo();
    const ledger = new SessionCaptureLedger();
    const d = deps(root, ledger);

    const created = await runLocalWrite(
      {
        path: "notes/one.md",
        content: "# One\n\nBody.\n",
        name: "One",
        summary: "First summary.",
      },
      d,
    );
    expect(created.ok).toBe(true);
    expect(json(created)).toMatchObject({ status: "ok", staged: true });
    expect(ledger.capturedPaths(root)).toEqual(["notes/one.md"]);

    const overall = await runLocalStatus({}, d);
    expect(json(overall)).toMatchObject({
      repoRoot: root,
      session_captures: ["notes/one.md"],
    });

    const status = await runLocalStatus({ path: "notes/one.md" }, d);
    expect(json(status)).toMatchObject({
      exists: true,
      in_index: true,
      modified: false,
      in_tracked: true,
      session_owned: true,
      revision: {
        worktree: expect.any(String),
        index: expect.any(String),
        head: null,
      },
    });

    const refined = await runLocalWrite(
      {
        path: "notes/one.md",
        content: "# One\n\nRefined.\n",
        summary: "Refined summary.",
        if_match: json(created).sha,
      },
      d,
    );
    expect(refined.ok).toBe(true);
    expect(readFileSync(join(root, "notes/one.md"), "utf8")).toContain("Refined summary.");
  });

  it("reports session captures under the canonical root from a symlinked cwd", async () => {
    const root = makeRepo();
    const container = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-symlink-cwd-")));
    cleanups.push(container);
    const linked = join(container, "linked-space");
    symlinkSync(root, linked, "dir");
    const d = deps(root);
    d.processCwd = linked;

    await runLocalWrite(
      { path: "notes/linked.md", content: "# Linked\n", name: "Linked" },
      d,
    );
    const status = await runLocalStatus({}, d);

    expect(status.ok).toBe(true);
    expect(json(status)).toMatchObject({
      repoRoot: root,
      session_captures: ["notes/linked.md"],
    });
  });

  it("keeps in_tracked compatible with stage-0 index membership", async () => {
    const root = makeRepo();
    const d = deps(root);
    expect(json(await runLocalStatus({ path: "seed.md" }, d))).toMatchObject({
      exists: true,
      in_tracked: true,
    });

    git(root, "rm", "--cached", "seed.md");
    expect(json(await runLocalStatus({ path: "seed.md" }, d))).toMatchObject({
      exists: true,
      in_index: true,
      in_tracked: false,
    });
  });

  it("preserves unknown frontmatter on a safe update", async () => {
    const root = makeRepo();
    mkdirSync(join(root, "notes"));
    writeFileSync(
      join(root, "notes/existing.md"),
      "---\nname: Existing\ncustom:\n  nested: true\n---\n# Existing\n",
    );
    git(root, "add", "notes/existing.md");
    git(root, "commit", "-qm", "add existing");
    const d = deps(root);

    const status = await runLocalStatus({ path: "notes/existing.md" }, d);
    const updated = await runLocalWrite(
      {
        path: "notes/existing.md",
        content: "# Existing\n\nNew body.\n",
        summary: "New summary.",
        if_match: json(status).sha,
      },
      d,
    );

    expect(updated.ok).toBe(true);
    const content = readFileSync(join(root, "notes/existing.md"), "utf8");
    expect(content).toContain("custom:\n  nested: true");
    expect(content).toContain("summary: New summary.");
  });

  it("refuses path escape, symlink, and untracked ignored writes", async () => {
    const root = makeRepo();
    const d = deps(root);

    const escaped = await runLocalWrite(
      { path: "../escaped.md", content: "# Escape\n", name: "Escape" },
      d,
    );
    expect(json(escaped)).toMatchObject({ status: "error", code: "path_escape" });

    symlinkSync(join(root, "seed.md"), join(root, "linked.md"));
    const linked = await runLocalWrite(
      { path: "linked.md", content: "# Replace link\n", force: true },
      d,
    );
    expect(json(linked)).toMatchObject({ status: "error", code: "symlink_refused" });

    writeFileSync(join(root, ".gitignore"), "*.local.md\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-qm", "ignore local notes");
    const ignored = await runLocalWrite(
      { path: "private.local.md", content: "# Private\n", name: "Private" },
      d,
    );
    expect(json(ignored)).toMatchObject({ status: "error", code: "ignored_local_path" });
    expect(existsSync(join(root, "private.local.md"))).toBe(false);
  });

  it("allows a tracked path even when a later ignore rule matches it", async () => {
    const root = makeRepo();
    writeFileSync(join(root, "shared.local.md"), "# Shared\n");
    git(root, "add", "shared.local.md");
    git(root, "commit", "-qm", "track shared local-shaped note");
    writeFileSync(join(root, ".gitignore"), "*.local.md\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-qm", "add later ignore rule");
    const d = deps(root);
    const status = await runLocalStatus({ path: "shared.local.md" }, d);

    const updated = await runLocalWrite(
      {
        path: "shared.local.md",
        content: "# Shared\n\nStill shared.\n",
        if_match: json(status).sha,
      },
      d,
    );

    expect(updated.ok).toBe(true);
    expect(readFileSync(join(root, "shared.local.md"), "utf8")).toContain("Still shared.");
  });

  it("all commits only this Pi ledger and preserves another session's index", async () => {
    const root = makeRepo();
    const first = deps(root, new SessionCaptureLedger());
    const second = deps(root, new SessionCaptureLedger());

    await runLocalWrite(
      { path: "notes/first.md", content: "# First\n", name: "First" },
      first,
    );
    await runLocalWrite(
      { path: "notes/second.md", content: "# Second\n", name: "Second" },
      second,
    );
    writeFileSync(join(root, "source.ts"), "export {};\n");
    git(root, "add", "source.ts");

    const committed = await runLocalCommit(
      { message: "Capture first", all: true, op: "capture" },
      first,
    );
    expect(committed.ok).toBe(true);
    expect(json(committed)).toMatchObject({
      status: "ok",
      committed_paths: ["notes/first.md"],
    });
    expect(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "notes/first.md",
    );
    expect(git(root, "diff", "--cached", "--name-only").split("\n").sort()).toEqual([
      "notes/second.md",
      "source.ts",
    ]);
    const message = git(root, "log", "-1", "--format=%B");
    expect(message).toContain("Op: capture");
    expect(message).toContain("Conversation: sess-test");
    expect(message).toContain("Change-Id: chg_pf3b-test");
    expect(message).toContain("Co-authored-by: test-pi <agent:test-pi@ideaspaces>");
    expect(first.ledger.capturedPaths(root)).toEqual([]);
    expect(second.ledger.capturedPaths(root)).toEqual(["notes/second.md"]);
  });

  it("commits a confirmed native edit by explicit path", async () => {
    const root = makeRepo();
    writeFileSync(join(root, "seed.md"), "# Seed\n\nNative refinement.\n");
    const d = deps(root);

    const result = await runLocalCommit(
      { message: "Refine seed", paths: ["seed.md"], op: "update" },
      d,
    );

    expect(result.ok).toBe(true);
    expect(json(result).committed_paths).toEqual([join(root, "seed.md")]);
    expect(git(root, "show", "--format=", "--name-only", "HEAD")).toBe("seed.md");
  });

  it.each(["worktree", "index", "head"] as const)(
    "refuses stale %s state from a captured revision",
    async (place) => {
      const root = makeRepo();
      const d = deps(root);
      await runLocalWrite(
        { path: "notes/stale.md", content: "# Original\n", name: "Stale" },
        d,
      );
      const original = readFileSync(join(root, "notes/stale.md"), "utf8");

      if (place === "worktree") {
        writeFileSync(join(root, "notes/stale.md"), "# Other worktree\n");
      } else if (place === "index") {
        writeFileSync(join(root, "notes/stale.md"), "# Other index\n");
        git(root, "add", "notes/stale.md");
        writeFileSync(join(root, "notes/stale.md"), original);
      } else {
        git(root, "commit", "-qm", "other session commits same path");
      }

      const before = git(root, "rev-parse", "HEAD");
      const result = await runLocalCommit(
        { message: "Commit stale", paths: ["notes/stale.md"] },
        d,
      );
      expect(result.ok).toBe(false);
      expect(json(result)).toMatchObject({ status: "error", code: "revision_mismatch" });
      expect(git(root, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("uses the full status review behind a legacy if_match SHA", async () => {
    const root = makeRepo();
    const d = deps(root);
    const status = await runLocalStatus({ path: "seed.md" }, d);
    const reviewedSha = json(status).sha;

    writeFileSync(join(root, "seed.md"), "# Different staged bytes\n");
    git(root, "add", "seed.md");
    git(root, "restore", "--source=HEAD", "--worktree", "seed.md");

    const result = await runLocalWrite(
      {
        path: "seed.md",
        content: "# Should not land\n",
        if_match: reviewedSha,
      },
      d,
    );
    expect(result.ok).toBe(false);
    expect(json(result)).toMatchObject({ status: "error", code: "revision_mismatch" });
    expect(readFileSync(join(root, "seed.md"), "utf8")).toBe("# Seed\n");
  });

  it("requires reconciliation for an existing Unicode path and lets force override it", async () => {
    const root = makeRepo();
    const d = deps(root);
    const path = "notes/Über review space.md";
    await runLocalWrite(
      { path, content: "# Original\n", name: "Original" },
      d,
    );

    const refused = await runLocalWrite(
      { path, content: "# Unreviewed\n", name: "Unreviewed" },
      d,
    );
    expect(refused.ok).toBe(false);
    expect(json(refused)).toMatchObject({ code: "revision_mismatch" });

    const forced = await runLocalWrite(
      { path, content: "# Reconciled\n", name: "Reconciled", force: true },
      d,
    );
    expect(forced.ok).toBe(true);
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toContain("# Reconciled");
  });

  it("commits native moves and deletions as literal explicit paths", { timeout: 15_000 }, async () => {
    const root = makeRepo();
    const d = deps(root);
    await runLocalWrite(
      { path: "notes/mover.md", content: "# Mover\n", name: "Mover" },
      d,
    );
    await runLocalCommit({ message: "Add mover", all: true }, d);

    git(root, "mv", "notes/mover.md", "notes/moved.md");
    const moved = await runLocalCommit(
      {
        message: "Move note",
        paths: ["notes/mover.md", "notes/moved.md"],
        op: "move",
      },
      d,
    );
    expect(moved.ok).toBe(true);
    expect(git(root, "show", "--name-status", "--format=", "-M", "HEAD")).toBe(
      "R100\tnotes/mover.md\tnotes/moved.md",
    );

    rmSync(join(root, "notes/moved.md"));
    const deleted = await runLocalCommit(
      { message: "Delete note", paths: ["notes/moved.md"], op: "delete" },
      d,
    );
    expect(deleted.ok).toBe(true);
    expect(git(root, "show", "--name-status", "--format=", "HEAD")).toBe(
      "D\tnotes/moved.md",
    );
  });

  it("fails incomplete identity before changing the index", async () => {
    const root = makeRepo();
    git(root, "config", "user.name", "");
    git(root, "config", "user.email", "");
    writeFileSync(join(root, "seed.md"), "# Identity must fail\n");

    const result = await runLocalCommit(
      { message: "No identity", paths: ["seed.md"] },
      deps(root),
    );
    expect(result.ok).toBe(false);
    expect(json(result)).toMatchObject({ status: "error", code: "invalid_identity" });
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  it("reports an atomic write failure without claiming or creating the path", async () => {
    const root = makeRepo();
    const ledger = new SessionCaptureLedger();
    const brokenFilesystem = {
      ...nodeLocalEffectFileSystem,
      async atomicWriteUtf8() {
        throw new Error("injected atomic failure");
      },
    };
    const d = deps(root, ledger, { git: runner(), filesystem: brokenFilesystem });

    const result = await runLocalWrite(
      { path: "notes/atomic.md", content: "# Atomic\n", name: "Atomic" },
      d,
    );
    expect(result.ok).toBe(false);
    expect(json(result)).toMatchObject({ status: "error", code: "atomic_write_failed" });
    expect(existsSync(join(root, "notes/atomic.md"))).toBe(false);
    expect(ledger.capturedPaths(root)).toEqual([]);
  });

  it("tracks a durable write partial and exposes recovery facts", async () => {
    const root = makeRepo();
    const ledger = new SessionCaptureLedger();
    const stageFailure = runner((args) =>
      args[0] === "add"
        ? { ok: false, stdout: "", stderr: "injected stage failure", code: 71 }
        : undefined,
    );
    const d = deps(root, ledger, capabilities(stageFailure));

    const result = await runLocalWrite(
      { path: "notes/partial.md", content: "# Partial\n", name: "Partial" },
      d,
    );

    expect(result.ok).toBe(false);
    expect(json(result)).toMatchObject({
      status: "partial",
      code: "stage_failed",
      completed_phases: ["revision_check", "write"],
      recovery_hint: expect.any(String),
    });
    expect(ledger.capturedPaths(root)).toEqual(["notes/partial.md"]);
    expect(readFileSync(join(root, "notes/partial.md"), "utf8")).toContain("# Partial");
  });

  it("retains selected revisions after an injected commit failure", async () => {
    const root = makeRepo();
    const ledger = new SessionCaptureLedger();
    const normal = deps(root, ledger);
    await runLocalWrite(
      { path: "notes/commit-partial.md", content: "# Partial\n", name: "Partial" },
      normal,
    );

    const commitFailure = runner((args) =>
      args.includes("commit")
        ? { ok: false, stdout: "", stderr: "injected commit failure", code: 72 }
        : undefined,
    );
    const result = await runLocalCommit(
      { message: "Should fail", all: true },
      deps(root, ledger, capabilities(commitFailure)),
    );

    expect(result.ok).toBe(false);
    expect(json(result)).toMatchObject({
      status: "partial",
      code: "commit_failed",
      phase: "commit",
      recovery_hint: expect.any(String),
    });
    expect(ledger.capturedPaths(root)).toEqual(["notes/commit-partial.md"]);
  });
});
