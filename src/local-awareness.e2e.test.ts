import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
let sessionManager: SessionManager;
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
  sessionManager = SessionManager.inMemory();
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
  it("keeps the session head stable while navigation appends reference focus", async () => {
    // Session cwd is the workspace. Its floor orientation is the authority head;
    // reading acme-space later must not replace it.
    const injected = await runner.emitBeforeAgentStart(
      "orient",
      undefined,
      "base prompt",
      { cwd: space } as any,
    );
    expect(injected?.systemPrompt).toContain("[IdeaSpaces Awareness]");
    expect(injected?.systemPrompt).toContain("Position:");
    expect(injected?.systemPrompt).toContain("acme-space/ (4)");
    expect(injected?.systemPrompt).not.toContain("Now: Home awareness.");
    expect(injected?.systemPrompt).not.toContain("ACME_FOUNDATION_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_PURPOSE_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_NOW_BODY_SENTINEL");
    expect(injected?.systemPrompt).not.toContain("ACME_README_BODY_SENTINEL");
    // Volatile facts never enter the cached prefix (cache placement split).
    expect(injected?.systemPrompt).not.toContain("Repos in scope (local):");
    expect(injected?.systemPrompt).not.toContain("State:");

    // Anthropic receives the volatile block after its explicit breakpoint.
    // Codex and other prefix-matching providers receive persisted state instead.
    (runner as any).getModel = () => ({ provider: "anthropic", id: "claude-3-7-sonnet" });
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

    const focused = await call("is_navigate", { path: "acme-space" });
    const focusedText = text(focused);
    const injectedPrompt = injected?.systemPrompt ?? "";
    const injectedStable = injectedPrompt.split("[IdeaSpaces Awareness]\n")[1] ?? "";
    expect(injectedStable).not.toBe("");
    expect(focusedText).toContain("Focus:");
    expect(focusedText).toContain("contract role: reference — read, never composed");
    expect(focusedText).toContain("Tree (");
    expect(focusedText).toContain("Agent context:");
    expect(focusedText).toContain("  guide — Work from bounded evidence.");
    expect(focusedText).toContain("  now — Home awareness.");
    expect(focusedText).toContain("Operating skills:");
    expect(focusedText).toContain("  review — Review an invented plan.");
    expect(focusedText).not.toContain("Position:");
    expect(focusedText).not.toContain("Now:");
    expect(focusedText).not.toContain("ACME_GUIDE_BODY_SENTINEL");
    expect(focusedText).not.toContain("ACME_SKILL_BODY_SENTINEL");

    const looked = await call("is_look", {
      path: "acme-space/README.md",
      depth: "full",
    });
    expect(text(looked)).toContain("Look:\n  position: README.md");
    expect(text(looked)).toContain("depth: full");
    expect(text(looked)).toContain("ACME_README_BODY_SENTINEL");
    expect(text(looked)).toContain("contract role: reference — read, never composed");
    expect(looked.details?.contract).toBe("foundation");

    const probed = text(await call("is_navigate", { path: "acme-space", depth: 3 }));
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
    expect(afterProbe?.systemPrompt?.split("[IdeaSpaces Awareness]\n")[1]).toBe(injectedStable);

    const siblingFocus = await call("is_navigate", { path: "sibling" });
    expect(text(siblingFocus)).toContain("Focus:");
    expect(text(siblingFocus)).toContain("now — Sibling awareness.");
    expect(text(siblingFocus)).not.toContain("Mounted content (read-only)");
    expect(text(siblingFocus)).not.toContain("Now:");

    // The one permitted CLI call is the cached remote catalog fetch. Local
    // status/navigate/look/inspect reads would hit the fake CLI's exit-99 branch.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(cliLog)).toBe(true);
    const calls = readFileSync(cliLog, "utf-8").trim().split("\n").filter(Boolean);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((line) => line.split(/\s+/).includes("catalog"))).toBe(true);
  }, 10_000);

  it("persists State as custom messages across Codex turns without mutating provider input", async () => {
    (runner as any).getModel = () => ({ provider: "openai-codex", id: "gpt-6-sol" });
    (runner as any).cwd = space;

    // Turn 1: Initial state is emitted as a persisted custom message turn.
    const turn1 = await runner.emitBeforeAgentStart("hello", undefined, "base prompt", { cwd: space } as any);
    expect(turn1?.systemPrompt).toContain("[IdeaSpaces Awareness]");
    const firstState = turn1?.messages?.[0];
    expect(firstState?.customType).toBe("is_state");
    const stateText = (firstState?.content?.[0] as { text: string }).text;
    expect(stateText).toContain("[IdeaSpaces State]");
    expect(stateText).toContain("branch: main");
    sessionManager.appendCustomMessageEntry("is_state", firstState!.content, false);

    // Turn 1 provider request: input is untouched by before_provider_request.
    const turn1Input = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { role: "user", content: [{ type: "input_text", text: stateText }] },
      ],
    };
    const beforeTurn1 = structuredClone(turn1Input);
    await runner.emitBeforeProviderRequest(turn1Input);
    expect(turn1Input).toEqual(beforeTurn1);

    // Turn 2: Unchanged state emits NO custom message, keeping history cache prefix intact.
    const turn2 = await runner.emitBeforeAgentStart("next question", undefined, "base prompt", { cwd: space } as any);
    expect(turn2?.systemPrompt).toContain("[IdeaSpaces Awareness]");
    expect(turn2?.messages ?? []).toHaveLength(0);

    // Turn 2 provider request: input is untouched.
    const turn2Input = {
      input: [
        ...turn1Input.input,
        { role: "assistant", content: [{ type: "text", text: "answer 1" }] },
        { role: "user", content: [{ type: "input_text", text: "next question" }] },
      ],
    };
    const beforeTurn2 = structuredClone(turn2Input);
    await runner.emitBeforeProviderRequest(turn2Input);
    expect(turn2Input).toEqual(beforeTurn2);
    expect(turn2Input.input.slice(0, turn1Input.input.length)).toEqual(turn1Input.input);

    // Tool execution changes state (e.g. stage a capture)
    const writeResult = await call("is_write", {
      path: "notes/sample.md",
      content: "Sample content",
      cwd: space,
    });
    expect(JSON.parse(text(writeResult))).toMatchObject({ staged: true });

    // tool_result event on Codex attaches updated State to tool result content
    const toolEvent = {
      toolName: "is_write",
      toolCallId: "call_1",
      input: { path: "notes/sample.md" },
      content: [{ type: "text", text: "tool output" }],
      structuredContent: { status: "ok" },
      isError: false,
    };
    const nestedResult = await runner.emitToolResult({
      ...toolEvent, toolCallId: "call_1/0", parentToolCallId: "call_1",
    } as any);
    expect(nestedResult).toBeUndefined();
    const updatedToolResult = await runner.emitToolResult(toolEvent as any);
    expect(updatedToolResult?.content).toBeDefined();
    const resultText = updatedToolResult!.content!.map((c: any) => c.text).join("");
    expect(resultText).toContain("[IdeaSpaces State]");
    expect(resultText).toContain("captures awaiting commit: 1");
    const unchangedResult = await runner.emitToolResult({
      ...toolEvent, toolCallId: "call_2", content: [{ type: "text", text: "unchanged" }],
    } as any);
    expect(unchangedResult).toBeUndefined();
    const followUpInput = {
      input: [
        ...turn2Input.input,
        { role: "assistant", content: [{ type: "text", text: "calling a tool" }] },
        { type: "function_call", call_id: "call_1", name: "is_write", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: resultText },
      ],
    };
    const beforeFollowUp = structuredClone(followUpInput);
    await runner.emitBeforeProviderRequest(followUpInput);
    expect(followUpInput).toEqual(beforeFollowUp);
    expect(followUpInput.input.slice(0, turn2Input.input.length)).toEqual(turn2Input.input);
    expect(JSON.stringify(followUpInput).match(/\[IdeaSpaces State\]/g)).toHaveLength(2);
    sessionManager.appendMessage({
      role: "toolResult", toolCallId: "call_1", toolName: "is_write",
      content: updatedToolResult!.content!, isError: false, timestamp: Date.now(),
    } as any);

    // Turn 3: State was updated during tool execution, so next turn with same state emits no duplicate.
    const turn3 = await runner.emitBeforeAgentStart("after tool", undefined, "base prompt", { cwd: space } as any);
    expect(turn3?.messages ?? []).toHaveLength(0);
    // A new process resumes from the branch entries, not extension-local memory.
    await runner.emit({ type: "session_start" } as any);
    const resumed = await runner.emitBeforeAgentStart("resumed", undefined, "base prompt", { cwd: space } as any);
    expect(resumed?.messages ?? []).toHaveLength(0);
    (runner as any).cwd = workspace;
  });

  it("leaves Vertex on its pre-PR request-time State path, including tool follow-ups", async () => {
    (runner as any).getModel = () => ({ provider: "google-vertex", id: "gemini-3.7-flash" });
    (runner as any).cwd = space;
    const start = await runner.emitBeforeAgentStart("run tool", undefined, "base prompt", { cwd: space } as any);
    expect(start?.messages ?? []).toHaveLength(0); // No persisted State on Vertex.

    const payload = {
      config: { systemInstruction: "stable" },
      contents: [
        { role: "user", parts: [{ text: "run tool" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "bash", response: { output: "ok" } } }] },
      ],
    };
    const before = structuredClone(payload);
    await runner.emitBeforeProviderRequest(payload);
    expect(payload.config).toEqual(before.config);
    expect(payload.contents.slice(0, -1)).toEqual(before.contents);
    expect(payload.contents.at(-1)).toEqual({
      role: "user", parts: [{ text: expect.stringContaining("[IdeaSpaces State]") }],
    });
    // A tool result is not rewritten by the Codex-only delta path.
    expect(await runner.emitToolResult({
      toolName: "bash", toolCallId: "vertex-call", input: { command: "true" },
      content: [{ type: "text", text: "ok" }], isError: false,
    } as any)).toBeUndefined();
    (runner as any).cwd = workspace;
  });

  it("warns once for an unsupported Anthropic tool follow-up without claiming the whole session failed", async () => {
    (runner as any).getModel = () => ({ provider: "anthropic", id: "claude-3-7-sonnet" });
    const initial = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    await runner.emitBeforeProviderRequest(initial);
    expect(initial.messages[0].content.at(-1)?.text).toContain("[IdeaSpaces State]");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const toolFollowUp = () => ({ messages: [
        { role: "user", content: [{ type: "text", text: "run tool" }] },
        { role: "tool", content: "result", tool_call_id: "c1" },
      ] });
      const failed = toolFollowUp();
      await runner.emitBeforeProviderRequest(failed);
      expect(failed).toEqual(toolFollowUp());
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = String(warn.mock.calls[0]?.[0]);
      expect(warning).toContain("tool-follow-up request");
      expect(warning).toContain("absent from this request");
      expect(warning).toContain("other requests may still receive them");
      expect(warning).not.toContain("absent from model context this session");

      await runner.emitBeforeProviderRequest(toolFollowUp());
      expect(warn).toHaveBeenCalledTimes(1);
      const later = { messages: [{ role: "user", content: [{ type: "text", text: "next" }] }] };
      await runner.emitBeforeProviderRequest(later);
      expect(later.messages[0].content.at(-1)?.text).toContain("[IdeaSpaces State]");
    } finally {
      warn.mockRestore();
    }
  });

  it("seeds mounts from IS_MOUNTS at load — navigable and readable without is_mount", async () => {
    // No is_mount call here: `seeded` was mounted purely by the IS_MOUNTS env at
    // extension load, so the host owns the durable set and re-seeds each turn.
    const mounted = await call("is_navigate", { root: "seeded", path: "." });
    expect(text(mounted)).toContain("Mounted content (read-only)");
    expect(text(mounted)).toContain("Focus:");
    expect(text(mounted)).toContain("now — Seeded awareness.");
    expect(text(mounted)).not.toContain("Now:");

    const looked = await call("is_look", {
      root: "seeded",
      path: "README.md",
      depth: "summary",
    });
    expect(text(looked)).toContain("Look:\n  position: README.md");
    expect(text(looked)).toContain("contract role: reference — read, never composed");
  });

  it("pins the protocol version that supplies the Content-tail composition", () => {
    expect(
      readFileSync(join(ROOT, "node_modules/@ideaspaces/protocol/VERSION"), "utf-8").trim(),
    ).toBe("0.22.1");
  });
});
