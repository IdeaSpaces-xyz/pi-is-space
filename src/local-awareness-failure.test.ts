import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const control = vi.hoisted(() => ({ failManifest: false, failCompose: false }));

vi.mock("@ideaspaces/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ideaspaces/protocol")>();
  return {
    ...actual,
    async assembleContentAwareness(
      opts: Parameters<typeof actual.assembleContentAwareness>[0],
    ) {
      if (control.failManifest) throw new Error("fixture manifest failure");
      return actual.assembleContentAwareness(opts);
    },
    async composeContractAlongPath(
      position: Parameters<typeof actual.composeContractAlongPath>[0],
    ) {
      if (control.failCompose) throw new Error("fixture compose failure");
      return actual.composeContractAlongPath(position);
    },
  };
});

import { buildLocalAwareness, discoverSpaceSkillPaths } from "./local-awareness.js";

let workspace: string;

beforeEach(async () => {
  workspace = realpathSync(await mkdtemp(join(tmpdir(), "is-pi-awareness-failure-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await fs.writeFile(join(workspace, "README.md"), "# Fixture\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "seed"]);
});

afterEach(async () => {
  control.failManifest = false;
  control.failCompose = false;
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("local awareness failure boundaries", () => {
  it("preserves independently-read State when Content assembly throws", async () => {
    control.failManifest = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildLocalAwareness({
      position: workspace,
      workspace,
    });

    expect(result).toMatchObject({ root: null, repoRoot: null, stable: null });
    expect(result.volatile).toContain("State:\n  branch: main");
    expect(result.volatile).toContain("working tree: clean");
    expect(warning).toHaveBeenCalledWith(
      "IdeaSpaces: Content awareness read failed: fixture manifest failure",
    );
  });

  it("degrades native skill discovery to an empty roster instead of throwing", async () => {
    // resources_discover fires on every /new, /resume, /fork, and reload — a
    // protocol read failure must warn and yield [], never crash the session.
    control.failCompose = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(discoverSpaceSkillPaths(workspace)).resolves.toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      "is: space skill discovery unavailable: Error: fixture compose failure",
    );
  });
});
