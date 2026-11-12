import { afterEach, describe, expect, it } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { THREAD_KINDS } from "@ideaspaces/protocol";
import { threadArgs, type ThreadRequest } from "./threads.js";
import { createHash } from "node:crypto";
import register from "./index.js";
import { AGENT_TOOLS } from "./generated/agent-tools.js";
import { cliOption } from "./catalog-adapter.js";
import { renderAgentSurfaceLine } from "./agent-surface-line.js";
import { belowRequired, inspectCatalog } from "./catalog-runtime.js";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function tools() {
  const out = new Map<string, any>();
  register({
    on() {},
    registerCommand() {},
    registerTool(t: any) {
      out.set(t.name, t);
    },
  } as any);
  return out;
}
describe("catalog-generated Pi contracts", () => {
  it("regenerates deterministically and a future read flag cannot silently drift", async () => {
    const { generate, canonical } = await import(
      "../scripts/generate-tools.mjs"
    );
    const c = read("node_modules/@ideaspaces/cli/bundle/agent-tools.json"),
      e = read("agent-tools.exposure.json"),
      h = read("agent-tools.host.json"),
      p = read("package.json");
    const original = readFileSync("src/generated/agent-tools.ts", "utf8");
    expect(generate(c, e, h, p)).toBe(original);
    c.entries.find(
      (e: any) => e.id === "look",
    ).parameters.properties.future_page = { type: "integer" };
    c.digest = `sha256:${createHash("sha256").update(canonical(c.entries)).digest("hex")}`;
    expect(generate(c, e, h, p)).not.toBe(original);
  });
  it("uses the shared short wording without protocol or full digest bytes", () => {
    const runtime = { available: true, comparisonComplete: true, version: "0.10.1", digest: AGENT_TOOLS.metadata.digest, changed: [], note: "matching" };
    expect(renderAgentSurfaceLine(runtime)).toBe("Agent tools: Pi extension 0.1.51 · CLI 0.10.1 · catalog 00eb3df2.");
    expect(renderAgentSurfaceLine()).toBe("Agent tools: Pi extension 0.1.51 · CLI unknown (no answer in 1.2 s) · catalog 00eb3df2.");
    const drift = { ...runtime, version: "0.11.0", digest: "sha256:7a1b2c3d" + "a".repeat(56) };
    expect(renderAgentSurfaceLine(drift)).toBe("Agent tools: Pi extension 0.1.51 · CLI 0.11.0 · catalog differs (built 00eb3df2, running 7a1b2c3d); tools keep working. Update the plugin to match.");
    expect(renderAgentSurfaceLine({ ...drift, changed: ["look", "threads.post", "commit", "status (unverified)"] })).toContain("3 tools changed; tools keep working.");
  });
  it("only counts completed, verified comparisons, never a cut-short prefix", async () => {
    const digest = "sha256:7a1b2c3d" + "a".repeat(56);
    const complete = await inspectCatalog(async args => ({ code: 0, err: "", out: JSON.stringify(args.length === 2 ? { cli: { version: "0.11.0" }, digest } : { entry: { changed: args[1] } }) }));
    expect(complete.comparisonComplete).toBe(true);
    expect(renderAgentSurfaceLine(complete)).toContain(`${complete.changed.length} tools changed`);
    let probes = 0;
    const partial = await inspectCatalog(async (args, signal) => {
      if (args.length === 2) return { code: 0, err: "", out: JSON.stringify({ cli: { version: "0.11.0" }, digest }) };
      if (probes++ === 0) return { code: 0, err: "", out: JSON.stringify({ entry: { changed: true } }) };
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ code: 1, err: "aborted", out: "" }), { once: true }));
    }, { deadlineMs: 30 });
    expect(probes).toBeGreaterThan(1);
    expect(partial.available).toBe(true);
    expect(partial.comparisonComplete).toBe(false);
    expect(renderAgentSurfaceLine(partial)).toContain("catalog differs");
    expect(renderAgentSurfaceLine({ ...partial, changed: ["look"] })).not.toContain("tools changed");
    const failed = await inspectCatalog(async args => args.length === 2
      ? { code: 0, err: "", out: JSON.stringify({ cli: { version: "0.11.0" }, digest }) }
      : { code: 1, err: "unavailable", out: JSON.stringify({ entry: null }) });
    const late = await inspectCatalog(async args => ({ code: 0, err: "", out: JSON.stringify(args.length === 2 ? { cli: { version: "0.11.0" }, digest } : { entry: { changed: true } }) }), { deadlineMs: 0 });
    expect(late.comparisonComplete).toBe(false); // A late timer must not authorize a count.
    expect(renderAgentSurfaceLine(late)).not.toContain("tools changed");
    expect(failed.comparisonComplete).toBe(false);
    expect(renderAgentSurfaceLine(failed)).not.toContain("tools changed");
  });
  it("checks literal cliOption calls against the runtime's exposed flag set", async () => {
    const { checkCliOptionLiterals } = await import("../scripts/generate-tools.mjs");
    expect(checkCliOptionLiterals([{ path: "fixture.ts", text: 'cliOption("--since", "--literal"); /* cliOption("--bogus", "x") */' }], AGENT_TOOLS.entries)).toBe(1);
    expect(() => checkCliOptionLiterals([{ path: "fixture.ts", text: 'cliOption(`--not-in-the-catalog`, "x")' }], AGENT_TOOLS.entries)).toThrow("fixture.ts:1");
  });
  it("keeps generation tooling development-only and out of the published package", () => {
    const pkg = read("package.json");
    expect(pkg.devDependencies.ajv).toBeTruthy();
    expect(pkg.dependencies.ajv).toBeUndefined();
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], { encoding: "utf8" }));
    const files = pack.files.map((f: {path: string}) => f.path) as string[];
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/generated/agent-tools.ts");
    expect(files.some(p => p.startsWith("scripts/") || p.endsWith(".test.ts") || p === "agent-tools.host.json" || p === "agent-tools.exposure.json")).toBe(false);
  });
  it("matches the pinned CLI's mark and supersedes rules, not just copied validation", () => {
    const catalog = read("node_modules/@ideaspaces/cli/bundle/agent-tools.json");
    const post = catalog.entries.find((e: any) => e.id === "threads.post");
    for (const field of ["kind", "mark", "supersedes", "reply_to"]) expect(post.parameters.properties[field]).toBeTruthy();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-thread-rules-"))); roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q"); git("config", "user.name", "Reader"); git("config", "user.email", "reader@example.test");
    mkdirSync(join(root, "_agent"));
    writeFileSync(join(root, "_agent/agreement.md"), "# Agreement — Reader\n");
    const a = "msg_00000001-fixture", b = "msg_00000002-fixture";
    const cases: Partial<ThreadRequest>[] = [
      { kind: "post" }, { kind: "mark" }, { kind: "mark", mark: "claimed", reply_to: [] },
      { kind: "mark", mark: "claimed", reply_to: ["latest"] }, { kind: "mark", mark: "claimed", reply_to: [a,b] },
      { kind: "correction" },
      ...THREAD_KINDS.flatMap(kind => [{ kind, mark: "claimed" }, { kind, supersedes: a }]),
    ];
    const cli = join(process.cwd(), "node_modules/@ideaspaces/cli/bundle/ideaspaces.js");
    for (const [i, fields] of cases.entries()) {
      const path = join(root, `_threads/rules-${i}`); mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "README.md"), "---\nname: Rules\n---\n# Rules\n");
      for (const [j,id] of [a,b].entries()) writeFileSync(join(path, `${j}.md`), `---\nid: ${id}\ndate: 2026-11-01T00:00:0${j}.000Z\nkind: post\n---\nParent.\n`);
      const input: ThreadRequest = { action: "post", path, message: "Rule parity.", author: "Reader", reply_to: [a], ...fields };
      let wrapperAccepts = true;
      try { threadArgs(input); } catch { wrapperAccepts = false; }
      const raw = ["threads", "post", path, "--message", input.message!, "--author", "Reader"];
      for (const key of ["kind", "mark", "supersedes"] as const) if (input[key] !== undefined) raw.push(`--${key}`, input[key]!);
      if (input.reply_to?.length) raw.push("--reply-to", input.reply_to.join(","));
      const actual = spawnSync(process.execPath, [cli, ...raw], { cwd: root, encoding: "utf8" });
      expect(actual.error).toBeUndefined();
      expect(wrapperAccepts, `${JSON.stringify(fields)}: ${actual.stderr || actual.stdout}`).toBe(actual.status === 0);
    }
  }, 30_000);
  it("offers all catalogued look paging and post-kind fields through the actual roster", () => {
    const t = tools();
    for (const k of ["agreement", "limit", "order", "post", "since"])
      expect(t.get("is_look").parameters.properties).toHaveProperty(k);
    for (const k of ["kind", "mark", "supersedes"])
      expect(t.get("is_threads").parameters.properties).toHaveProperty(k);
    expect(t.get("is_look").description).toBe(
      AGENT_TOOLS.tools.is_look.description,
    );
  });
  it("pages and opens a post, and writes a mark through the actual CLI with generated fields", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-catalog-proof-")));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Reader");
    git("config", "user.email", "reader@example.test");
    mkdirSync(join(root, "_agent"));
    writeFileSync(
      join(root, "_agent/agreement.md"),
      "---\nname: Agreement — Reader\nroot_node_id: n_0123456789abcdef01234567\n---\n# Reader\n",
    );
    const thread = join(root, "_threads", "work");
    mkdirSync(thread, { recursive: true });
    writeFileSync(join(thread, "README.md"), "---\nname: Work\n---\n# Work\n");
    for (let i = 0; i < 3; i++)
      writeFileSync(
        join(thread, `${i}.md`),
        `---\nid: msg_${String(i + 1).padStart(8, "0")}-fixture\ndate: 2026-11-01T00:00:0${i}.000Z\nkind: post\nname: Item ${i}\n---\nBody ${i}\n`,
      );
    git("add", ".");
    git("commit", "-qm", "fixtures");
    const t = tools(),
      ctx = { cwd: root };
    const invoke = (n: string, p: object) =>
      t.get(n).execute("proof", p, undefined, undefined, ctx);
    const first = await invoke("is_look", {
      path: "_threads/work",
      limit: 1,
      agreement: "full",
    });
    expect(first.content[0].text).toContain("0.md");
    expect(first.content[0].text).not.toContain("Item 2");
    const next = await invoke("is_look", {
      path: "_threads/work",
      limit: 1,
      since: "0.md",
      order: "older",
    });
    expect(next.content[0].text).toContain("1.md");
    const post = await invoke("is_look", {
      path: "_threads/work",
      post: "msg_00000002-fixture",
    });
    expect(post.content[0].text).toContain("Body 1");
    const written = await invoke("is_threads", {
      action: "post",
      path: thread,
      kind: "mark",
      mark: "claimed",
      reply_to: ["msg_00000002-fixture"],
      message: "--literal body",
      author: "Reader",
    });
    const data = JSON.parse(written.content[0].text);
    expect(readFileSync(data.path, "utf8")).toContain("kind: mark");
    expect(readFileSync(data.path, "utf8")).toContain("--literal body");
  }, 30_000);
  it("uses generated flag mappings and reports unknown runtime metadata honestly", async () => {
    expect(["look", "--since", cliOption("--since", "--child")]).toEqual([
      "look",
      "--since",
      "--since=--child",
    ]);
    expect(belowRequired("0.8.0", [">=0.9.0"])).toBe(true);
    expect(belowRequired("worktree", [">=0.11.0"])).toBe(false);
    expect(belowRequired("0.11.0-rc1", [">=0.11.0"])).toBe(false);
    expect(
      (await inspectCatalog(async () => ({ code: 1, err: "missing", out: "" })))
        .available,
    ).toBe(false);
  });
});
