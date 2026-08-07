import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerIdeaSpaces from "./index.js";

type RegisteredTool = {
  name: string;
  promptGuidelines?: string[];
  execute: (...args: any[]) => Promise<unknown> | unknown;
};

// Protocol-first cleanup row 11b deliberately leaves concrete parameter schemas
// harness-owned. This locks Pi's roster; protocol skills and Slice 0 e2e guard
// cross-surface semantics without recreating a shared signature literal.
const EXPECTED_PI_TOOL_NAMES = [
  "is_navigate",
  "is_inspect",
  "is_mount",
  "is_unmount",
  "is_auth",
  "is_write",
  "is_status",
  "is_commit",
  "is_change_open",
  "is_change_close",
  "is_pull",
  "is_push",
] as const;

function registeredTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerIdeaSpaces(pi);
  return tools;
}

describe("Pi tool registration contract", () => {
  it("keeps the harness-owned roster exact", () => {
    expect([...registeredTools().keys()].sort()).toEqual([...EXPECTED_PI_TOOL_NAMES].sort());
  });

  it("keeps navigation awareness-first outside the explicit orient skill", () => {
    const tool = registeredTools().get("is_navigate");
    expect(tool?.promptGuidelines).toEqual([
      "Treat the injected [IdeaSpaces Awareness] map as the first bounded orientation rung: use is_navigate only when focus or map depth must change, and do not reread represented contract or current-state files or follow their links unless the user's question requires deeper evidence.",
    ]);
  });

  it("keeps inspection on the progressive-disclosure ladder", () => {
    const tool = registeredTools().get("is_inspect");
    expect(tool?.promptGuidelines).toEqual([
      "Use is_inspect only when the awareness/map summary leaves a material question: request an outline before a section, and a section before any native full-file read.",
      "Use Pi's native read instead of is_inspect only when exact full-document or implementation evidence is required; is_inspect has no full-document mode.",
    ]);
  });

  it("requires section-only parameters to match the selected rung", async () => {
    const tool = registeredTools().get("is_inspect");
    expect(tool).toBeDefined();
    await expect(
      tool!.execute("test", { path: "acme.md", mode: "section" }, undefined, undefined, { cwd: "." }),
    ).rejects.toThrow("requires a non-empty `heading`");
    await expect(
      tool!.execute("test", { path: "acme.md", mode: "summary", heading: "Plan" }, undefined, undefined, { cwd: "." }),
    ).rejects.toThrow("require section mode");
  });

  it("requires a handle or id before opening a Change", async () => {
    const tool = registeredTools().get("is_change_open");
    expect(tool).toBeDefined();
    await expect(tool!.execute("test", {}, undefined, undefined, {})).rejects.toThrow(
      "Provide `handle` to mint a new Change, or `id` to continue one.",
    );
  });
});
