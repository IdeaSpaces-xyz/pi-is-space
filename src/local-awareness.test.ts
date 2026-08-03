import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLocalAwareness,
  readCaptureStatus,
  readMountedAwareness,
  readPathStatusText,
} from "./local-awareness.js";

const CLI = join(process.cwd(), "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");

let workspace: string;

beforeEach(async () => {
  workspace = realpathSync(await mkdtemp(join(tmpdir(), "is-pi-awareness-")));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeSpace(root: string, summary: string): Promise<void> {
  await fs.mkdir(join(root, "_agent"), { recursive: true });
  await fs.writeFile(
    join(root, "_agent", "foundation.md"),
    `---\nname: Foundation\nsummary: Foundation for ${summary}\n---\n# Foundation\n`,
  );
  await fs.writeFile(
    join(root, "_agent", "purpose.md"),
    `---\nname: Purpose\nsummary: Purpose for ${summary}\n---\n# Purpose\n\nServe ${summary}.\n`,
  );
  await fs.writeFile(
    join(root, "_agent", "now.md"),
    `---\nname: Now\nsummary: ${summary}\n---\n# Now\n\n${summary}\n`,
  );
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "seed"]);
}

describe("local awareness", () => {
  it("matches the current CLI status + navigate awareness text", async () => {
    const home = join(workspace, "home");
    const sibling = join(workspace, "sibling");
    const mount = join(workspace, "mount");
    await fs.mkdir(home);
    await fs.mkdir(sibling);
    await fs.mkdir(mount);
    await makeSpace(home, "Home focus.");
    await makeSpace(sibling, "Sibling handle.");
    await makeSpace(mount, "Mounted handle.");

    const statusRun = spawnSync("node", [CLI, "--json", "status"], {
      cwd: home,
      encoding: "utf-8",
    });
    expect(statusRun.status, statusRun.stderr).toBe(0);
    const status = JSON.parse(statusRun.stdout);
    const state = [
      "State:",
      `  branch: ${status.branch ?? "(detached)"}`,
      status.ahead != null || status.behind != null
        ? `  remote: ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0}`
        : "  remote: no upstream",
      `  working tree: ${status.dirty ? "dirty" : "clean"}`,
      `  captures awaiting commit: ${status.tracked_captures.length}`,
    ].join("\n");
    const navRun = spawnSync(
      "node",
      [
        CLI,
        "--json",
        "navigate",
        home,
        "--workspace",
        workspace,
        "--no-git",
        "--mount",
        mount,
        "--pullable",
        "online:alice",
      ],
      { cwd: home, encoding: "utf-8" },
    );
    expect(navRun.status, navRun.stderr).toBe(0);
    const nav = JSON.parse(navRun.stdout) as { text: string };

    const local = await buildLocalAwareness({
      position: home,
      workspace,
      mounts: [mount],
      pullable: [{ slug: "online", namespace: "alice" }],
    });
    expect(local.text).toBe(`${state}\n\n${nav.text}`);
  });

  it("composes state, canonical Content sections, working set, and catalog", async () => {
    const home = join(workspace, "home");
    const sibling = join(workspace, "sibling");
    const mount = join(workspace, "mount");
    await fs.mkdir(home);
    await fs.mkdir(sibling);
    await fs.mkdir(mount);
    await makeSpace(home, "Home focus.");
    await makeSpace(sibling, "Sibling handle.");
    await makeSpace(mount, "Mounted handle.");

    const seen = git(home, ["rev-parse", "HEAD"]);
    git(home, ["update-ref", "refs/ideaspaces/seen", seen]);
    await fs.writeFile(join(home, "README.md"), "# Home\n");
    git(home, ["add", "README.md"]);
    git(home, ["commit", "-q", "-m", "advance"]);
    await fs.writeFile(join(home, "pending.md"), "# Pending\n");
    git(home, ["add", "pending.md"]);

    const result = await buildLocalAwareness({
      position: home,
      workspace,
      mounts: [mount],
      pullable: [{ slug: "online", namespace: "alice" }],
    });

    expect(result.root).toBe(home);
    expect(result.repoRoot).toBe(home);
    expect(result.text).toContain("State:\n  branch: main");
    expect(result.text).toContain("working tree: dirty");
    expect(result.text).toContain("captures awaiting commit: 1");
    expect(result.text).toContain(`Position:\n  repo: ${home}`);
    expect(result.text).toContain("Now: Home focus.");
    expect(result.text).toContain("Since last session (1 changes):");
    expect(result.text).toContain("Working set:");
    expect(result.text).toContain("  home: home — Home focus.");
    expect(result.text).toContain(`  mount: ${mount} — Mounted handle.`);
    expect(result.text).toContain("Repos in scope (local):");
    expect(result.text).toContain("home — Home focus. (local-only · dirty · POV)");
    expect(result.text).toContain("sibling — Sibling handle. (local-only)");
    expect(result.text).toContain("Pullable (remote — not yet local):");
    expect(result.text).toContain("online (alice)");
    expect(result.text).not.toContain("Git:");

    expect(result.text!.indexOf("State:")).toBeLessThan(
      result.text!.indexOf("Position:"),
    );
    expect(result.text!.indexOf("Since last session")).toBeLessThan(
      result.text!.indexOf("Working set:"),
    );
    expect(result.text!.indexOf("Working set:")).toBeLessThan(
      result.text!.indexOf("Repos in scope"),
    );
  });

  it("orients a bare workspace through its local catalog", async () => {
    const child = join(workspace, "child");
    await fs.mkdir(child);
    await makeSpace(child, "Child repo.");

    const result = await buildLocalAwareness({
      position: workspace,
      workspace,
    });
    expect(result.root).toBeNull();
    expect(result.repoRoot).toBeNull();
    expect(result.text).toContain("Repos in scope (local):");
    expect(result.text).toContain("Navigate into a repo below");

    const cliRun = spawnSync(
      "node",
      [CLI, "--json", "navigate", workspace, "--workspace", workspace, "--no-git"],
      { cwd: workspace, encoding: "utf-8" },
    );
    expect(cliRun.status, cliRun.stderr).toBe(0);
    expect(result.text).toBe(JSON.parse(cliRun.stdout).text);
  });

  it("matches the CLI clone hint in an empty bare workspace", async () => {
    const result = await buildLocalAwareness({
      position: workspace,
      workspace,
    });
    expect(result.text).toContain("no repos yet");
    expect(result.text).not.toContain("Navigate into a repo below");

    const cliRun = spawnSync(
      "node",
      [CLI, "--json", "navigate", workspace, "--workspace", workspace, "--no-git"],
      { cwd: workspace, encoding: "utf-8" },
    );
    expect(cliRun.status, cliRun.stderr).toBe(0);
    expect(result.text).toBe(JSON.parse(cliRun.stdout).text);
  });

  it("returns path status and staged capture facts in-process", async () => {
    const home = join(workspace, "home");
    await fs.mkdir(home);
    await makeSpace(home, "Home.");
    await fs.writeFile(join(home, "note.md"), "# Note\n");
    git(home, ["add", "note.md"]);

    const status = await readCaptureStatus(home);
    expect(status?.tracked_captures).toEqual(["note.md"]);
    const path = JSON.parse(await readPathStatusText(home, "note.md"));
    expect(path).toMatchObject({
      path: "note.md",
      exists: true,
      in_index: true,
      modified: false,
      in_tracked: true,
    });
    expect(path.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("renders mounted Content without operating state or workspace catalog", async () => {
    const mount = join(workspace, "mount");
    await fs.mkdir(mount);
    await makeSpace(mount, "Mounted focus.");

    const result = await readMountedAwareness(mount);
    expect(result.root).toBe(mount);
    expect(result.text).toContain("Position:");
    expect(result.text).toContain("Now: Mounted focus.");
    expect(result.text).not.toContain("State:");
    expect(result.text).not.toContain("Working set:");
    expect(result.text).not.toContain("Repos in scope");
    expect(result.text).not.toContain("Git:");
  });
});
