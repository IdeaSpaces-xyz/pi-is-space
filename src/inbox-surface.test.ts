import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMIT, PACKAGE_VERSION } from "./pins.js";

const ROOT = process.cwd();
const CLI = join(ROOT, "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

describe("hosted Thread distribution", () => {
  it("pins the CLI release carrying direct exchanges", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(pkg.dependencies?.["@ideaspaces/cli"]).toBe(
      `github:IdeaSpaces-xyz/cli#${CLI_COMMIT}`,
    );
  });

  it("ships follow, cursor reads, send, and reply through the installed CLI", () => {
    const result = spawnSync(process.execPath, [CLI, "threads", "--help"], { encoding: "utf-8" });
    const help = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(help).toContain("ideaspaces threads <list|");
    expect(help).toContain("threads read x_<id> --new --ack");

    // Subcommand usage, unlike the generic help, reveals whether this installed CLI accepts a Map.
    const send = spawnSync(process.execPath, [CLI, "threads", "send"], { encoding: "utf-8" });
    const reply = spawnSync(process.execPath, [CLI, "threads", "reply"], { encoding: "utf-8" });
    expect(send.status).toBe(1);
    expect(`${send.stdout}${send.stderr}`).toContain("[--map <selection.json>]");
    expect(reply.status).toBe(1);
    expect(`${reply.stdout}${reply.stderr}`).toContain("threads reply <thread_id>");
    // A future CLI pin adding reply Maps must update the skill's pin-specific limitation too.
    expect(`${reply.stdout}${reply.stderr}`).not.toContain("[--map <selection.json>]");

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
    expect(skill).toContain("is_cli threads list --new --depth name");
    expect(skill).toContain("Use `is_follow`");
    expect(skill).toContain("Only explicit acknowledgement advances");
    expect(skill).toContain("is_cli threads send");
    expect(skill).toContain("is_cli threads reply");
    expect(skill).toContain("A Map is optional");
    expect(skill).toContain("**No Map**");
    expect(skill).toContain("**Inherit**");
    expect(skill).toContain("`is_cli threads reply` **without");
    expect(skill).toContain("`threads --help` is a generic overview");
    expect(skill).toContain("older versions may silently ignore it");
    expect(skill).toContain("do not use raw API calls");
    expect(skill).toContain("is_cli inbox list --kind request");
    expect(skill).toContain("use `is-threads` and its `is_threads` tool");
    expect(skill).toContain("acts as the logged-in person");
    expect(skill).toContain("Never substitute a bare Agent");
    expect(skill).toContain("reuse that exact id only when retrying");
  });
});
