import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMap } from "@ideaspaces/protocol";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CLI = join(ROOT, "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

describe("derived local Map distribution", () => {
  it("ships the installed command and teaches deliberate inspection", () => {
    const help = spawnSync(process.execPath, [CLI, "map", "--help"], { encoding: "utf8" });
    const text = `${help.stdout}${help.stderr}`;
    const skill = readFileSync(join(ROOT, "skills/is-capture/SKILL.md"), "utf8");

    expect(help.status).toBe(0);
    expect(text).toContain("map [<repo>] [--depth <1..4|full>]");
    expect(skill).toContain("is_cli map <repo> --depth full --json");
    expect(skill).toContain("offline working-tree observation, not an automatic capture");
    expect(skill).toContain("`portable`, `dirty`, and `local_only_paths`");
  });

  it("maps a plain five-level repository through the installed CLI", () => {
    const repo = mkdtempSync(join(tmpdir(), "is-pi-derived-map-"));
    try {
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.email", "map@example.com"]);
      git(repo, ["config", "user.name", "Map Test"]);
      git(repo, ["remote", "add", "origin", "https://GitHub.com/Acme/Research.git"]);
      const deep = join(repo, "one", "two", "three", "four", "five");
      mkdirSync(deep, { recursive: true });
      writeFileSync(
        join(deep, "finding.md"),
        "---\nname: Finding\nsummary: Deep finding.\n---\n# Finding\n",
      );
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      const result = spawnSync(
        process.execPath,
        [CLI, "map", repo, "--depth", "full", "--json"],
        { cwd: repo, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        kind: "derived-map",
        depth: "full",
        complete: true,
        portable: true,
      });
      expect(parseMap(output.map).status).toBe("valid");
      expect(output.map.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            position: "one/two/three/four/five/finding.md",
            depth: "summary",
          }),
        ]),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
