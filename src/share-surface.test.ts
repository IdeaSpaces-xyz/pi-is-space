import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CLI = join(ROOT, "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

describe("recipient-shaped Share distribution", () => {
  it("pins the CLI release used by tool subprocesses", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe("0.1.9");
    expect(pkg.dependencies?.["@ideaspaces/cli"]).toBe(
      "github:IdeaSpaces-xyz/cli#0407cf30eacc703d3cf4f04afbbe89af8cad6196",
    );
  });

  it("ships the people, teams, and visibility help through the installed CLI", () => {
    const result = spawnSync(process.execPath, [CLI, "share", "--help"], { encoding: "utf-8" });
    const help = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(help).toContain("share <person|team|list|remove|visibility>");
    expect(help).toContain("--grade explore");
    expect(help).toContain("--grade fork");
    expect(help).toContain("--grade collaborate");
    expect(help).toContain("share visibility public");
    expect(help).toContain("share visibility private");
    expect(help).not.toContain("share <invite|");
    expect(help).not.toContain("set-access");
  });

  it("routes recipient access through is-share rather than is-push", () => {
    const share = read("skills/is-share/SKILL.md");
    const push = read("skills/is-push/SKILL.md");

    expect(share).toContain("share person");
    expect(share).toContain("share team");
    expect(share).toContain("share visibility public");
    expect(share).toContain("$IS_CLI_PATH");
    expect(share).toContain("there is no\nnative `is_share` tool");
    expect(share).toContain("Never ask for internal user, organization, Grant, userset, or repository");
    expect(push).toContain("Push is not access sharing");
    expect(push).toContain("belong to **is-share**");
  });
});
