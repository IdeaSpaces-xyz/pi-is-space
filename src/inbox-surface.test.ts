import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CLI = join(ROOT, "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");
const CLI_COMMIT = "b4a26a3e8a6e6ba854e07d290dbbc44d92340718";

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

describe("direct Inbox distribution", () => {
  it("pins the CLI release carrying direct exchanges", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe("0.1.36");
    expect(pkg.dependencies?.["@ideaspaces/cli"]).toBe(
      `github:IdeaSpaces-xyz/cli#${CLI_COMMIT}`,
    );
  });

  it("ships follow, cursor reads, send, and reply through the installed CLI", () => {
    const result = spawnSync(process.execPath, [CLI, "inbox", "--help"], { encoding: "utf-8" });
    const help = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(help).toContain("inbox <list|read|send|reply|expand>");
    expect(help).toContain("inbox list --new --depth name");
    expect(help).toContain("inbox read x_example --new --depth full --ack");
    expect(help).toContain("inbox send @owner --about");
    expect(help).toContain("inbox reply x_example");

    const follow = spawnSync(process.execPath, [CLI, "follow", "--help"], { encoding: "utf-8" });
    const followHelp = `${follow.stdout}${follow.stderr}`;
    expect(follow.status).toBe(0);
    expect(followHelp).toContain("follow <thread|node|repo> <id> [--ack <position>]");

    const unfollow = spawnSync(process.execPath, [CLI, "unfollow", "--help"], { encoding: "utf-8" });
    const unfollowHelp = `${unfollow.stdout}${unfollow.stderr}`;
    expect(unfollow.status).toBe(0);
    expect(unfollowHelp).toContain("unfollow <thread|node|repo> <id>");
  });

  it("teaches the person-accountable CLI boundary to local agents", () => {
    const skill = read("skills/is-inbox/SKILL.md");

    expect(skill).toContain("$IS_CLI_PATH");
    expect(skill).toContain("is_cli inbox list --new --depth name");
    expect(skill).toContain("Use `is_follow`");
    expect(skill).toContain("Only acknowledgement advances");
    expect(skill).toContain("is_cli inbox send");
    expect(skill).toContain("is_cli inbox reply");
    expect(skill).toContain("acts as the logged-in person");
    expect(skill).toContain("Never substitute a bare Agent");
    expect(skill).toContain("reuse that exact id only when retrying");
  });
});
