import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COMMON_TOOL_CONTRACT,
  type SharedToolContract,
  type ToolParameterContract,
} from "@ideaspaces/sdk/tool-contract";
import registerIdeaSpaces from "./index.js";

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type RegisteredTool = {
  name: string;
  parameters: JsonSchema;
  execute: (...args: any[]) => Promise<unknown> | unknown;
};

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

function enumValues(schema: JsonSchema): string[] | undefined {
  if (schema.enum) return schema.enum.filter((value): value is string => typeof value === "string");
  const variants = schema.anyOf ?? schema.oneOf;
  if (!variants) return undefined;
  const values = variants.map((variant) => variant.const);
  return values.every((value) => typeof value === "string") ? values as string[] : undefined;
}

function normalizeParameters(schema: JsonSchema): Record<string, ToolParameterContract> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, parameter]) => {
      const values = enumValues(parameter);
      let type: ToolParameterContract["type"];
      if (parameter.type === "array" && parameter.items?.type === "string") type = "string[]";
      else if (parameter.type === "string" || values) type = "string";
      else if (parameter.type === "boolean") type = "boolean";
      else throw new Error(`Unsupported Pi parameter schema: ${name}`);

      return [
        name,
        {
          type,
          required: required.has(name),
          ...(values ? { values } : {}),
        },
      ];
    }),
  );
}

describe("Pi common tool contract", () => {
  it("matches every common non-surface-specific argument", () => {
    const tools = registeredTools();

    for (const [name, contract] of Object.entries(
      COMMON_TOOL_CONTRACT as Readonly<Record<string, SharedToolContract>>,
    )) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      if (contract.parameters === "surface-specific") continue;
      expect(normalizeParameters(tool!.parameters), name).toEqual(contract.parameters);
    }
  });

  it("requires a handle or id before opening a Change", async () => {
    const tool = registeredTools().get("is_change_open");
    expect(tool).toBeDefined();
    await expect(tool!.execute("test", {}, undefined, undefined, {})).rejects.toThrow(
      "Provide `handle` to mint a new Change, or `id` to continue one.",
    );
  });
});
