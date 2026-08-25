import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendVolatileTail,
  buildLocalAwareness,
  discoverSpaceSkillPaths,
  probeTree,
  readCaptureStatus,
  readMountedAwareness,
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
  it("probeTree renders a one-shot outline: handles at level 1, names below", async () => {
    const home = join(workspace, "home");
    await makeSpace(home, "probe test");
    await fs.mkdir(join(home, "research", "deep"), { recursive: true });
    await fs.writeFile(
      join(home, "research", "README.md"),
      "---\nname: Research\nsummary: EU landscape sweep.\n---\n# R\n",
    );
    await fs.writeFile(join(home, "research", "deep", "more.md"), "# More\n");

    const probed = await probeTree(home, 2);
    expect(probed).toContain("research/ (2) — EU landscape sweep.");
    expect(probed).toContain("    deep/ (1)");
    // Depth is a one-shot render; the ambient block is built elsewhere at depth 1.
    const ambient = await readMountedAwareness(home);
    expect(ambient.text).not.toContain("    deep/ (1)");
  });


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
    // Split registers: the CLI's navigate text is stable sections + catalog;
    // the catalog is volatile (async pullable, sync states), so parity holds
    // piecewise around that boundary. State leads the volatile register.
    const catalogIdx = nav.text.indexOf("Repos in scope (local):");
    expect(catalogIdx).toBeGreaterThan(0);
    const navStable = nav.text.slice(0, catalogIdx).trimEnd();
    const navCatalog = nav.text.slice(catalogIdx).trimEnd();
    expect(local.stable).toBe(navStable);
    expect(local.volatile).toBe(`${state}\n\n${navCatalog}`);
  });

  it("keeps the stable register byte-identical across rebuilds with unchanged state", async () => {
    const home = join(workspace, "home");
    await fs.mkdir(home);
    await makeSpace(home, "Stability check.");
    const opts = { position: home, workspace };
    const first = await buildLocalAwareness(opts);
    const second = await buildLocalAwareness(opts);
    expect(first.stable).toBeTruthy();
    expect(second.stable).toBe(first.stable);
    // Volatile-only facts never leak into the stable register.
    expect(first.stable).not.toContain("State:");
    expect(first.stable).not.toContain("Since last session");
    expect(first.stable).not.toContain("Repos in scope");
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
    // Stable register: orientation + working set.
    expect(result.stable).toContain(`Position:\n  repo: ${home}`);
    expect(result.stable).toContain("Now: Home focus.");
    expect(result.stable).toContain("Working set:");
    expect(result.stable).toContain("  home: home — Home focus.");
    expect(result.stable).toContain(`  mount: ${mount} — Mounted handle.`);
    expect(result.stable).not.toContain("Since last session");
    expect(result.stable).not.toContain("State:");
    // Volatile register: State, activity, catalog.
    expect(result.volatile).toContain("State:\n  branch: main");
    expect(result.volatile).toContain("working tree: dirty");
    expect(result.volatile).toContain("captures awaiting commit: 1");
    expect(result.volatile).toContain("Since last session (1 changes):");
    expect(result.volatile).toContain("Repos in scope (local):");
    expect(result.volatile).toContain("home — Home focus. (local-only · dirty · POV)");
    expect(result.volatile).toContain("sibling — Sibling handle. (local-only)");
    expect(result.volatile).toContain("Pullable (remote — not yet local):");
    expect(result.volatile).toContain("online (alice)");
    expect(result.volatile).not.toContain("Git:");

    // Register-internal ordering: State leads the volatile register; the
    // working set rides the stable register after orientation.
    expect(result.volatile!.indexOf("State:")).toBeLessThan(
      result.volatile!.indexOf("Since last session"),
    );
    expect(result.volatile!.indexOf("Since last session")).toBeLessThan(
      result.volatile!.indexOf("Repos in scope"),
    );
    expect(result.stable!.indexOf("Position:")).toBeLessThan(
      result.stable!.indexOf("Working set:"),
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
    expect(result.stable).toBeNull();
    expect(result.volatile).toContain("Repos in scope (local):");
    expect(result.volatile).toContain("Navigate into a repo below");

    const cliRun = spawnSync(
      "node",
      [CLI, "--json", "navigate", workspace, "--workspace", workspace, "--no-git"],
      { cwd: workspace, encoding: "utf-8" },
    );
    expect(cliRun.status, cliRun.stderr).toBe(0);
    expect(result.volatile).toBe(JSON.parse(cliRun.stdout).text);
  });

  it("matches the CLI clone hint in an empty bare workspace", async () => {
    const result = await buildLocalAwareness({
      position: workspace,
      workspace,
    });
    expect(result.volatile).toContain("no repos yet");
    expect(result.volatile).not.toContain("Navigate into a repo below");

    const cliRun = spawnSync(
      "node",
      [CLI, "--json", "navigate", workspace, "--workspace", workspace, "--no-git"],
      { cwd: workspace, encoding: "utf-8" },
    );
    expect(cliRun.status, cliRun.stderr).toBe(0);
    expect(result.volatile).toBe(JSON.parse(cliRun.stdout).text);
  });

  it("returns staged capture facts in-process", async () => {
    const home = join(workspace, "home");
    await fs.mkdir(home);
    await makeSpace(home, "Home.");
    await fs.writeFile(join(home, "note.md"), "# Note\n");
    git(home, ["add", "note.md"]);

    const status = await readCaptureStatus(home);
    expect(status?.tracked_captures).toEqual(["note.md"]);
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

describe("appendVolatileTail", () => {
  it("appends after the breakpointed block of the last user message", () => {
    const payload = {
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "done", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    expect(appendVolatileTail(payload, "[IdeaSpaces State]\ntail")).toBe(true);
    const last = payload.messages[2].content;
    expect(last).toHaveLength(2);
    // The breakpoint block is untouched and still precedes the tail.
    expect((last[0] as { cache_control?: unknown }).cache_control).toBeDefined();
    expect(last[1]).toEqual({ type: "text", text: "[IdeaSpaces State]\ntail" });
  });

  it("leaves unrecognized payload shapes untouched", () => {
    const stringContent = { messages: [{ role: "user", content: "plain" }] };
    expect(appendVolatileTail(stringContent, "tail")).toBe(false);
    expect(stringContent.messages[0].content).toBe("plain");
    expect(appendVolatileTail({ prompt: "x" }, "tail")).toBe(false);
    expect(appendVolatileTail(null, "tail")).toBe(false);
  });
});

describe("discoverSpaceSkillPaths", () => {
  it("returns root-level entries only — both forms, README excluded, branches stay out", async () => {
    const home = join(workspace, "home");
    await makeSpace(home, "native skills");
    const skillsDir = join(home, "_agent", "skills");
    await fs.mkdir(join(skillsDir, "pdf-report"), { recursive: true });
    await fs.writeFile(
      join(skillsDir, "meeting-notes.md"),
      "---\nname: meeting-notes\ndescription: Decision-first records.\n---\n# Meeting notes\n",
    );
    await fs.writeFile(
      join(skillsDir, "pdf-report", "SKILL.md"),
      "---\nname: pdf-report\ndescription: Render a report.\n---\n# PDF report\n",
    );
    await fs.writeFile(
      join(skillsDir, "README.md"),
      "---\nname: Skills\nsummary: Convention marker.\n---\n# Skills\n",
    );
    // Branch skills are awareness-discovered, never session-start acquisitions.
    const branchSkills = join(home, "clients", "_agent", "skills");
    await fs.mkdir(branchSkills, { recursive: true });
    await fs.writeFile(
      join(branchSkills, "acme.md"),
      "---\nname: acme\ndescription: Branch-only.\n---\n# Acme\n",
    );

    // From the root and from a deep position, the acquisition set is identical.
    for (const cwd of [home, join(home, "clients")]) {
      const paths = await discoverSpaceSkillPaths(cwd);
      expect(paths.sort()).toEqual([
        join(skillsDir, "meeting-notes.md"),
        join(skillsDir, "pdf-report", "SKILL.md"),
      ]);
    }
  });

  it("returns [] outside a foundation-marked space or without skills", async () => {
    const bare = join(workspace, "bare");
    await fs.mkdir(bare, { recursive: true });
    expect(await discoverSpaceSkillPaths(bare)).toEqual([]);

    const empty = join(workspace, "empty");
    await makeSpace(empty, "no skills");
    expect(await discoverSpaceSkillPaths(empty)).toEqual([]);
  });
});
