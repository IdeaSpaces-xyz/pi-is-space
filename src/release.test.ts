import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReleases,
  planCompaction,
  prepareRelease,
  renderReleaseRecord,
  verifyReleases,
  RELEASE_ENTRY,
  type BranchEntry,
  type ReleaseItem,
} from "./release.js";

let root: string;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), "is-pi-release-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "release@example.com"]);
  git(["config", "user.name", "Release Test"]);
  await fs.mkdir(join(root, "_agent"), { recursive: true });
  await fs.writeFile(join(root, "_agent", "agreement.md"), "---\nsummary: Agreement.\n---\n# Agreement\n");
  await fs.mkdir(join(root, "notes"), { recursive: true });
  await fs.writeFile(
    join(root, "notes", "decision.md"),
    "---\nname: Decision\nsummary: The selected boundary.\n---\n# Decision\n\nBody.\n",
  );
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function entry(item: ReleaseItem): BranchEntry {
  return { type: "custom", customType: RELEASE_ENTRY, data: item };
}

describe("prepareRelease", () => {
  it("reads a committed item at the target rung with the sha the Map names", async () => {
    const outcome = await prepareRelease({ path: "notes/decision.md", cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.item).toMatchObject({
      path: "notes/decision.md",
      repoRoot: root,
      position: "notes/decision.md",
      depth: "summary",
      disclosure: { name: "Decision", summary: "The selected boundary." },
      revision: git(["rev-parse", "HEAD:notes/decision.md"]),
      commit: git(["rev-parse", "HEAD"]),
    });
    const named = await prepareRelease({ path: join(root, "notes/decision.md"), to: "name", cwd: root });
    expect(named.ok && named.item.depth).toBe("name");
  });

  it("refuses a modified item with a capture proposal", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Decision\n\nEdited.\n");
    const outcome = await prepareRelease({ path: "notes/decision.md", cwd: root });
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.text).toContain("Capture it first — is_write, then is_commit");
  });

  it("refuses an untracked, missing, or escaping item", async () => {
    await fs.writeFile(join(root, "notes", "new.md"), "# New\n");
    expect((await prepareRelease({ path: "notes/new.md", cwd: root })).ok).toBe(false);
    expect(await prepareRelease({ path: "notes/none.md", cwd: root })).toMatchObject({ ok: false, text: expect.stringContaining("does not exist") });
    expect(await prepareRelease({ path: "../elsewhere.md", cwd: root })).toMatchObject({ ok: false, text: expect.stringContaining("outside the repository root") });
  });
});

describe("collectReleases", () => {
  const base: ReleaseItem = {
    path: "a.md", repoRoot: "/r", position: "a.md", depth: "summary",
    disclosure: { name: "A" }, revision: "1", commit: "c", released_at: 1,
  };

  it("takes entries since the last compaction, latest per position, in first-release order", () => {
    const entries: BranchEntry[] = [
      entry({ ...base, position: "old.md", released_at: 0 }),
      { type: "compaction", details: { [RELEASE_ENTRY]: [] } },
      entry(base),
      entry({ ...base, position: "b.md", released_at: 2 }),
      { type: "message" },
      entry({ ...base, depth: "name", revision: "2", released_at: 3 }),
    ];
    expect(collectReleases(entries).map((i) => [i.position, i.depth, i.revision])).toEqual([
      ["a.md", "name", "2"],
      ["b.md", "summary", "1"],
    ]);
    expect(collectReleases([{ type: "message" }])).toEqual([]);
  });

  it("is consumed only by a compaction that carried the record", () => {
    const entries: BranchEntry[] = [
      entry(base),
      { type: "compaction" }, // Pi's default, or a boundary with no model: no record
      { type: "compaction", details: { other: true } },
    ];
    expect(collectReleases(entries).map((i) => i.position)).toEqual(["a.md"]);
    expect(collectReleases([...entries, { type: "compaction", details: { [RELEASE_ENTRY]: [base] } }])).toEqual([]);
  });
});

describe("planCompaction", () => {
  const item: ReleaseItem = {
    path: "notes/decision.md", repoRoot: "", position: "notes/decision.md", depth: "summary",
    disclosure: { name: "Decision", summary: "The selected boundary." }, revision: "0", commit: "c", released_at: 1,
  };

  it("leaves compaction to Pi when nothing was released", async () => {
    expect(await planCompaction("manual", [{ type: "message" }])).toEqual({ kind: "default" });
  });

  it("records ready items with their sha at HEAD", async () => {
    const plan = await planCompaction("threshold", [entry({ ...item, repoRoot: root })]);
    expect(plan.kind).toBe("record");
    if (plan.kind !== "record") return;
    const blob = git(["rev-parse", "HEAD:notes/decision.md"]);
    expect(plan.ready[0].revision).toBe(blob);
    expect(plan.dirty).toEqual([]);
    expect(plan.record).toContain(`Root: ${root}`);
    expect(plan.record).toContain(`- notes/decision.md (summary, blob ${blob.slice(0, 12)}): Decision — The selected boundary.`);
    expect(plan.record).toContain("re-read any item in full with is_look");
  });

  it("stops a manual compaction on a dirty item, and only a manual one", async () => {
    await fs.writeFile(join(root, "notes", "decision.md"), "# Decision\n\nEdited after release.\n");
    const entries = [entry({ ...item, repoRoot: root })];
    const manual = await planCompaction("manual", entries);
    expect(manual).toMatchObject({ kind: "cancel", message: expect.stringContaining("notes/decision.md differ from HEAD") });
    const threshold = await planCompaction("threshold", entries);
    expect(threshold.kind).toBe("record");
    if (threshold.kind !== "record") return;
    expect(threshold.ready).toEqual([]);
    expect(threshold.dirty.map((d) => d.position)).toEqual(["notes/decision.md"]);
    expect(threshold.record).toContain("Not released — content differs from HEAD, capture it first:");
  });

  it("verifies through an injected revision reader", async () => {
    const verified = await verifyReleases([item], async () => ({ worktree: "x", head: "x" }));
    expect(verified.ready[0].revision).toBe("x");
    expect(renderReleaseRecord([], [item])).toContain("  - notes/decision.md");
  });
});
