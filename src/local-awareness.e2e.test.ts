import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const savedEnv: Record<string, string | undefined> = {};

let home: string;
let workspace: string;
let space: string;
let sibling: string;
let seeded: string;
let cliLog: string;
let runner: ExtensionRunner;
let ctx: import("@earendil-works/pi-coding-agent").ExtensionContext;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function makeSpace(root: string, now: string): void {
  mkdirSync(join(root, "_agent", "skills"), { recursive: true });
  mkdirSync(join(root, "work", "archive"), { recursive: true });
  writeFileSync(
    join(root, "_agent", "foundation.md"),
    '---\nname: Acme foundation\nsummary: "Baseline for a synthetic Acme workspace."\n---\n# Foundation\n\nACME_FOUNDATION_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "_agent", "purpose.md"),
    '---\nname: Acme purpose\nsummary: "Practice a generic planning workflow."\n---\n# Purpose\n\nACME_PURPOSE_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "_agent", "guide.md"),
    '---\nname: Acme guide\nsummary: "Work from bounded evidence."\n---\n# Guide\n\nACME_GUIDE_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "_agent", "skills", "review.md"),
    '---\nname: acme-review\nsummary: "Review an invented plan."\n---\n# Review\n\nACME_SKILL_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "_agent", "now.md"),
    `---\nname: Acme now\nsummary: ${JSON.stringify(now)}\n---\n# Now\n\n${now}\n\n## Detailed tasks\n\nACME_NOW_BODY_SENTINEL\n\n## Later\n\nACME_LATER_BODY_SENTINEL\n`,
  );
  writeFileSync(
    join(root, "README.md"),
    '---\nname: Acme space\nsummary: "Synthetic public acceptance fixture."\n---\n# Acme Space\n\nACME_README_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "work", "README.md"),
    '---\nname: Generic work\nsummary: "Invented work items."\n---\n# Work\n\nACME_WORK_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "work", "archive", "details.md"),
    '---\nname: Archived details\nsummary: "ACME_DEEP_SUMMARY_SENTINEL"\n---\n# Details\n\nACME_DEEP_BODY_SENTINEL\n',
  );
  writeFileSync(
    join(root, "work", "large.md"),
    `# Large\n\n${"synthetic evidence\n".repeat(4_000)}`,
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "add", ".");
  git(root, "commit", "-qm", "seed");
}

async function call(
  name: string,
  params: Record<string, unknown>,
): Promise<{ content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }> {
  const tool = runner.getToolDefinition(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return await tool.execute(`tc-${name}`, params, undefined, undefined, ctx) as {
    content?: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
}

function text(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.map((entry) => entry.text ?? "").join("") ?? "";
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "is-pi-local-home-"));
  workspace = mkdtempSync(join(tmpdir(), "is-pi-local-workspace-"));
  space = join(workspace, "acme-space");
  sibling = join(workspace, "sibling");
  seeded = join(workspace, "seeded");
  mkdirSync(space);
  mkdirSync(sibling);
  mkdirSync(seeded);
  makeSpace(space, "Home awareness.");
  makeSpace(sibling, "Sibling awareness.");
  // Pre-seeded via IS_MOUNTS (below) — mounted at extension load, not by is_mount.
  makeSpace(seeded, "Seeded awareness.");

  cliLog = join(home, "cli-calls.log");
  const fakeCli = join(home, "fake-cli.js");
  writeFileSync(
    fakeCli,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(cliLog)}, process.argv.slice(2).join(" ") + "\\n");`,
      'if (process.argv.includes("catalog")) {',
      '  process.stdout.write(JSON.stringify({ entries: [] }));',
      '  process.exit(0);',
      '}',
      'process.stderr.write("local read reached the CLI");',
      'process.exit(99);',
    ].join("\n"),
  );

  for (const [key, value] of Object.entries({
    HOME: home,
    IS_CLI_PATH: fakeCli,
    // The host's durable mount set — read by the extension at load (same env
    // channel as IS_CLI_PATH). Proves seeding without an is_mount call.
    IS_MOUNTS: seeded,
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  })) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const agentDir = join(home, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const loaded = await discoverAndLoadExtensions(
    [join(ROOT, "src/index.ts")],
    workspace,
    agentDir,
  );
  const sessionManager = SessionManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    workspace,
    sessionManager,
    new ModelRegistry(modelRuntime),
  );
  ctx = runner.createContext();
}, 60_000);

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("Pi in-process local awareness", () => {
  it("injects awareness and serves status/navigation while a local-read CLI would fail", async () => {
    // Session cwd is the workspace; move focus into the home repo so awareness
    // carries both deep home orientation and sibling workspace handles.
    await call("is_navigate", { path: "acme-space" });
    const injected = await runner.emitBeforeAgentStart(
      "orient",
      undefined,
      "base prompt",
      { cwd: space } as any,
    );
    expect(injected?.systemPrompt).toContain("[IdeaSpaces Awareness]");
    expect(injected?.systemPrompt).toContain("Now: Home awareness.");
    expect(injected?.systemPrompt).not.toContain("ACME_FOUNDATION_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_PURPOSE_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_NOW_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_README_BODY_SENTINEL");
    // Volatile facts never enter the cached prefix (cache placement split).
    expect(injected?.systemPrompt).not.toContain("Repos in scope (local):");
    expect(injected?.systemPrompt).not.toContain("State:");

    // The volatile register lands per LLM call, strictly after the last
    // cache breakpoint — outside every cached prefix.
    const payload = {
      system: [{ type: "text", text: injected!.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "orient", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    await runner.emitBeforeProviderRequest(payload);
    const blocks = payload.messages[0].content as Array<{ type: string; text?: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toBeDefined();
    expect(blocks[1].text).toContain("[IdeaSpaces State]");
    expect(blocks[1].text).toContain("Repos in scope (local):");
    expect(blocks[1].text).toContain("sibling");

    const status = await call("is_status", { path: "README.md", cwd: space });
    expect(JSON.parse(text(status))).toMatchObject({
      path: "README.md",
      exists: true,
      in_tracked: true,
    });

    const summary = text(await call("is_inspect", {
      path: "_agent/now.md",
      cwd: space,
    }));
    expect(summary).toContain("Summary of");
    expect(summary).toContain("Home awareness.");
    expect(summary).not.toContain("ACME_NOW_BODY_SENTINEL");
    expect(summary).not.toContain("ACME_LATER_BODY_SENTINEL");

    const outline = text(await call("is_inspect", {
      path: "_agent/now.md",
      cwd: space,
      mode: "outline",
    }));
    expect(outline).toContain("## Detailed tasks");
    expect(outline).toContain("## Later");
    expect(outline).not.toContain("ACME_NOW_BODY_SENTINEL");
    expect(outline).not.toContain("ACME_LATER_BODY_SENTINEL");

    const section = text(await call("is_inspect", {
      path: "_agent/now.md",
      cwd: space,
      mode: "section",
      heading: "Detailed tasks",
    }));
    expect(section).toContain("ACME_NOW_BODY_SENTINEL");
    expect(section).not.toContain("ACME_LATER_BODY_SENTINEL");

    const largePath = join(space, "work", "large.md");
    const large = await call("is_inspect", {
      path: largePath,
      mode: "section",
      heading: "Large",
    });
    expect(text(large)).toContain("[Inspection truncated:");
    expect(text(large)).toContain("Use native read with offsets");
    expect(large.details?.truncation).toMatchObject({ truncated: true });

    const moved = await call("is_navigate", { path: "." });
    const movedText = text(moved);
    const injectedPrompt = injected?.systemPrompt ?? "";
    const injectedStable = injectedPrompt.split("[IdeaSpaces Awareness]\n")[1] ?? "";
    expect(injectedStable).not.toBe("");
    expect(movedText).toContain("Awareness focus moved to .");
    expect(movedText.endsWith(injectedStable)).toBe(true);
    expect(movedText).toContain("Position:");
    expect(movedText).toContain("Now: Home awareness.");
    expect(movedText).toContain("Tree (");
    expect(movedText).toContain("Agent context:");
    expect(movedText).toContain("  guide — Work from bounded evidence.");
    expect(movedText).toContain("Operating skills:");
    expect(movedText).toContain("  review — Review an invented plan.");
    expect(movedText).not.toContain("ACME_GUIDE_BODY_SENTINEL");
    expect(movedText).not.toContain("ACME_SKILL_BODY_SENTINEL");

    const probed = text(await call("is_navigate", { path: ".", depth: 3 }));
    expect(probed).toContain("One-shot tree probe:");
    expect(probed).toContain("    archive/ (1)");
    expect(probed).toContain("      details.md");
    expect(probed).not.toContain("ACME_DEEP_SUMMARY_SENTINEL");
    expect(probed).not.toContain("ACME_DEEP_BODY_SENTINEL");

    const afterProbe = await runner.emitBeforeAgentStart(
      "continue",
      undefined,
      "base prompt",
      { cwd: space } as any,
    );
    expect(afterProbe?.systemPrompt).not.toContain("archive/ (1)");
    expect(afterProbe?.systemPrompt).not.toContain("details.md");
    expect(afterProbe?.systemPrompt).not.toContain("One-shot tree probe:");

    await call("is_mount", { path: sibling });
    const mounted = await call("is_navigate", { root: "sibling", path: "." });
    expect(text(mounted)).toContain("Mounted content (read-only)");
    expect(text(mounted)).toContain("Now: Sibling awareness.");

    // The one permitted CLI call is the cached remote catalog fetch. Local
    // status/navigate/inspect reads would hit the fake CLI's exit-99 branch.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(cliLog)).toBe(true);
    const calls = readFileSync(cliLog, "utf-8").trim().split("\n").filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((line) => line.split(/\s+/).includes("catalog"))).toBe(true);
  }, 10_000);

  it("seeds mounts from IS_MOUNTS at load — navigable without is_mount", async () => {
    // No is_mount call here: `seeded` was mounted purely by the IS_MOUNTS env at
    // extension load, so the host owns the durable set and re-seeds each turn.
    const mounted = await call("is_navigate", { root: "seeded", path: "." });
    expect(text(mounted)).toContain("Mounted content (read-only)");
    expect(text(mounted)).toContain("Now: Seeded awareness.");
  });

  it("pins the protocol version that supplies full-depth Content trees", () => {
    expect(
      readFileSync(join(ROOT, "node_modules/@ideaspaces/protocol/VERSION"), "utf-8").trim(),
    ).toBe("0.13.1");
  });
});
