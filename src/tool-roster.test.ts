import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerIdeaSpaces from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<unknown> | unknown;
};

const EXPECTED_PI_TOOL_NAMES = [
  "is_navigate",
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

  it("requires a handle or id before opening a Change", async () => {
    const tool = registeredTools().get("is_change_open");
    expect(tool).toBeDefined();
    await expect(tool!.execute("test", {}, undefined, undefined, {})).rejects.toThrow(
      "Provide `handle` to mint a new Change, or `id` to continue one.",
    );
  });
});
