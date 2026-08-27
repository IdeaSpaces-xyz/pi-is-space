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
    expect(pkg.version).toBe("0.1.11");
    expect(pkg.dependencies?.["@ideaspaces/cli"]).toBe(
      "github:IdeaSpaces-xyz/cli#ce8d9454f6c6c34902f69ef37a1970d6a40c58e2",
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
    expect(read("skills/is-share/SKILL.md")).toContain(
      "anyone may View and materialize a local Fork without an account",
    );
    expect(help).not.toContain("share <invite|");
    expect(help).not.toContain("set-access");
  });

  it("routes recipient access through is-share rather than is-push", () => {
    const share = read("skills/is-share/SKILL.md");
    const fork = read("skills/is-fork/SKILL.md");
    const push = read("skills/is-push/SKILL.md");

    expect(share).toContain("share person");
    expect(share).toContain("share team");
    expect(share).toContain("share visibility public");
    expect(share).toContain("$IS_CLI_PATH");
    expect(share).toContain("there is no\nnative `is_share` tool");
    expect(share).toContain("Never ask for internal user, organization, Grant, userset, or repository");
    expect(fork).toContain('is_cli fork "<space-url>" "<destination>"');
    expect(fork).toContain("Publishing is the account boundary;\nFork itself is not");
    expect(push).toContain("Push is not access sharing");
    expect(push).toContain("belong to **is-share**");
  });
});
