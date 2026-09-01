// /is-publish consumes the CLI's plan-first contract: plan (no --yes, zero
// mutations) → the person agrees → apply (--yes). The stub CLI records every
// invocation, so the assertions are about what actually ran.

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
  delete process.env.IS_CLI_PATH;
  delete process.env.IS_STUB_LOG;
  delete process.env.IS_STUB_ALWAYS_PLAN;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeSpace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-publish-plan-")));
  cleanups.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test Person");
  git(root, "config", "user.email", "person:tester@ideaspaces");
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent/foundation.md"), "# Foundation\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "seed");
  return root;
}

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IS_STUB_LOG, JSON.stringify(args) + "\\n");
const has = (f) => args.includes(f);
if (has("status")) {
  process.stdout.write(JSON.stringify({
    root_identity: { root_node_id: "n_0123456789abcdef01234567", state: "aligned", declaration: { dirty: false } },
  }));
} else if (has("publish") && (!has("--yes") || process.env.IS_STUB_ALWAYS_PLAN === "1")) {
  process.stdout.write(JSON.stringify({
    plan: {
      action: "publish", namespace: "tester", slug: "plan-space",
      root_node_id: "n_0123456789abcdef01234567",
      remote_url: "https://git.test/spaces/n_0123456789abcdef01234567.git",
      identity_email: "person:tester@ideaspaces", tip_author_rewrite: false, commits: 1,
    },
    applied: false,
  }));
} else if (has("publish")) {
  process.stdout.write(JSON.stringify({
    repo_id: "repo_plan", root_node_id: "n_0123456789abcdef01234567",
    slug: "plan-space", namespace: "tester",
    remote_url: "https://git.test/spaces/n_0123456789abcdef01234567.git",
    web_url: "https://web.test/spaces/n_0123456789abcdef01234567",
    identity_email: "person:tester@ideaspaces", identity_state: "aligned",
  }));
} else {
  process.stdout.write("{}");
}
`;

async function publishHarness(root: string, opts: { confirm: boolean; alwaysPlan?: boolean }) {
  const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-stub-")));
  cleanups.push(stubDir);
  const stubPath = join(stubDir, "stub-cli.js");
  const logPath = join(stubDir, "calls.log");
  writeFileSync(stubPath, STUB);
  writeFileSync(logPath, "");
  process.env.IS_CLI_PATH = stubPath;
  process.env.IS_STUB_LOG = logPath;
  if (opts.alwaysPlan) process.env.IS_STUB_ALWAYS_PLAN = "1";

  // resolveCli() caches at module load — reset the registry and import fresh
  // with the stub env in place.
  vi.resetModules();
  const { default: registerIdeaSpaces } = await import("./index.js");
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  registerIdeaSpaces(pi);

  const notices: string[] = [];
  const confirms: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager: { getSessionId: () => "sess-publish-plan" },
    ui: {
      setStatus() {},
      setWidget() {},
      notify(message: string) {
        notices.push(message);
      },
      async select() {
        return "Use folder defaults";
      },
      async input(_prompt: string, fallback: string) {
        return fallback;
      },
      async editor(_prompt: string, fallback: string) {
        return fallback;
      },
      async confirm(title: string, body: string) {
        confirms.push(`${title}\n${body}`);
        return opts.confirm;
      },
    },
  } as unknown as ExtensionContext;

  const cliCalls = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

  return { command: commands.get("is-publish")!, ctx, notices, confirms, cliCalls };
}

describe("/is-publish is plan-first", () => {
  it("runs the plan without --yes, shows it, applies with --yes only after the yes", async () => {
    const root = makeSpace();
    const { command, ctx, notices, confirms, cliCalls } = await publishHarness(root, { confirm: true });

    await command.handler("", ctx);

    const publishCalls = cliCalls().filter((args) => args.includes("publish"));
    expect(publishCalls.length).toBe(2);
    expect(publishCalls[0]).not.toContain("--yes");
    expect(publishCalls[1]).toContain("--yes");
    // The confirm body is the CLI's plan, not a hand-written summary.
    expect(confirms.at(-1)).toContain("tester/plan-space");
    expect(confirms.at(-1)).toContain("Nothing has happened yet");
    expect(notices.at(-1)).toContain("Published tester/plan-space");
  }, 20_000);

  it("declining the plan applies nothing", async () => {
    const root = makeSpace();
    const { command, ctx, notices, cliCalls } = await publishHarness(root, { confirm: false });

    await command.handler("", ctx);

    const publishCalls = cliCalls().filter((args) => args.includes("publish"));
    expect(publishCalls.length).toBe(1);
    expect(publishCalls[0]).not.toContain("--yes");
    expect(notices.at(-1)).toContain("nothing was changed");
  }, 20_000);

  it("never reports a plan payload as a publish", async () => {
    const root = makeSpace();
    const { command, ctx, notices } = await publishHarness(root, { confirm: true, alwaysPlan: true });

    await command.handler("", ctx);

    expect(notices.at(-1)).toContain("did not apply");
    expect(notices.join("\n")).not.toContain("Published tester/plan-space");
  }, 20_000);
});
