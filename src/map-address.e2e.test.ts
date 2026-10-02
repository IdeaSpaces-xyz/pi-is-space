import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = "a".repeat(40);
const savedEnv: Record<string, string | undefined> = {};

let home: string;
let space: string;
let calls: string;
let runner: ExtensionRunner;
let ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;

async function call(name: string, params: Record<string, unknown>) {
  const tool = runner.getToolDefinition(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return await tool.execute(`tc-${name}`, params, undefined, undefined, ctx) as {
    content?: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
}

const recorded = () =>
  existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "is-pi-map-address-home-"));
  space = mkdtempSync(join(tmpdir(), "is-pi-map-address-space-"));
  mkdirSync(join(space, "_agent"));
  writeFileSync(join(space, "_agent", "agreement.md"), "---\nname: Agreement — Test\n---\n# Test\n");
  mkdirSync(join(space, "notes"));
  writeFileSync(join(space, "notes", "a.md"), "---\nname: A\nsummary: Working tree\n---\n# A\n");
  execFileSync("git", ["-C", space, "init", "-q"]);

  calls = join(home, "calls.jsonl");
  const fakeCli = join(home, "fake-cli.js");
  // Records argv and the launch Map it inherited; fails for an address naming "gone".
  writeFileSync(
    fakeCli,
    [
      'import { appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("catalog")) { process.stdout.write(JSON.stringify({ entries: [] })); process.exit(0); }',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, map: process.env.IDEASPACES_MAP ?? null }) + "\\n");`,
      'if (args.some((arg) => arg.startsWith("@gone//"))) { process.stderr.write("status: unreachable — No local checkout"); process.exit(1); }',
      'process.stdout.write("Map read: " + args[1] + "\\n");',
    ].join("\n"),
  );

  for (const [key, value] of Object.entries({
    HOME: home,
    IS_CLI_PATH: fakeCli,
    IDEASPACES_MAP: "/launch/space.map.md",
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const agentDir = join(home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const loaded = await discoverAndLoadExtensions([join(ROOT, "src/index.ts")], space, agentDir);
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, allowModelNetwork: false });
  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, space, SessionManager.inMemory(), new ModelRegistry(modelRuntime));
  ctx = runner.createContext();
}, 60_000);

beforeEach(() => {
  rmSync(calls, { force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(space, { recursive: true, force: true });
});

describe("Pi Map address reads", () => {
  it("reads an address through the CLI with the launch Map inherited and no path named", async () => {
    const looked = await call("is_look", { address: "@notes//ideas", depth: "children", at: "pin" });
    await call("is_look", { address: "//ideas", map: "other.map.md" });
    await call("is_look", { path: "@notes//ideas/first.md" });
    const focus = await call("is_navigate", { address: "@notes//ideas" });

    expect(looked.content?.[0]?.text).toBe("Map read: @notes//ideas");
    expect(focus.content?.[0]?.text).toBe("Map read: @notes//ideas");
    expect(recorded()).toEqual([
      { args: ["look", "@notes//ideas", "--at", "pin", "--depth", "children"], map: "/launch/space.map.md" },
      { args: ["look", "//ideas", "--map", "other.map.md", "--depth", "summary"], map: "/launch/space.map.md" },
      { args: ["look", "@notes//ideas/first.md", "--depth", "summary"], map: "/launch/space.map.md" },
      { args: ["navigate", "@notes//ideas"], map: "/launch/space.map.md" },
    ]);
  });

  it("surfaces the CLI's own failure", async () => {
    await expect(call("is_look", { address: "@gone//x" })).rejects.toThrow("status: unreachable — No local checkout");
  });

  it("reads any Content at an authored pin, not only Thread posts", async () => {
    await call("is_look", { path: "notes/a.md", pin: PIN, position: "notes/a.md", depth: "full" });
    expect(recorded()).toEqual([{ args: ["look", "notes/a.md", "--pin", PIN, "--depth", "full"], map: "/launch/space.map.md" }]);
  });

  it("refuses mixed or missing coordinates before invoking the CLI", async () => {
    for (const params of [
      { address: "@notes//x", path: "notes/a.md" },
      { address: "@notes//x", pin: PIN },
      { address: "@notes//x", root: "elsewhere" },
      { path: "notes/a.md", map: "space.map.md" },
      { path: "notes/a.md", pin: PIN },
      { path: "notes/a.md", pin: PIN, position: "notes/b.md" },
      {},
    ]) {
      await expect(call("is_look", params), JSON.stringify(params)).rejects.toThrow();
    }
    await expect(call("is_navigate", { address: "@notes//x", depth: 2 })).rejects.toThrow();
    expect(recorded()).toEqual([]);
  });
});
