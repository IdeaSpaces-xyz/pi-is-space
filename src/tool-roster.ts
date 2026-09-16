/**
 * The roster is fixed at session start.
 *
 * Tools render first in the provider prompt, ahead of system and messages;
 * adding, removing, or reordering one invalidates every cached byte behind
 * it. So every tool this extension offers is registered at load, its schema
 * serialized in one sorted order, and nothing may join or leave afterwards.
 * Tool closure never removes; release applies to content, not the roster.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type SchemaRecord = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * One deterministic serialization of a parameter schema: object properties
 * and `required` in sorted key order, recursively. Values keep their own
 * metadata; only key order changes.
 */
export function frozenParameters<T extends TSchema>(schema: T): T {
  const record = schema as unknown as SchemaRecord;
  if (!record || typeof record !== "object" || !record.properties) return schema;
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(record.properties).sort()) {
    properties[key] = frozenParameters(record.properties[key] as TSchema);
  }
  const sorted: SchemaRecord = { ...record, properties };
  if (Array.isArray(record.required)) sorted.required = [...record.required].sort();
  return sorted as unknown as T;
}

export interface FrozenRoster {
  /** Register one tool with its schema frozen. Refuses once the roster is sealed. */
  register: ExtensionAPI["registerTool"];
  /** Close the roster: registration after this throws. */
  seal(): void;
  /** Names registered, in registration order. */
  names(): readonly string[];
}

export function frozenRoster(pi: Pick<ExtensionAPI, "registerTool">): FrozenRoster {
  const names: string[] = [];
  let sealed = false;
  return {
    register<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>) {
      if (sealed) {
        throw new Error(`The tool roster is fixed at session start; ${tool.name} cannot be added later.`);
      }
      names.push(tool.name);
      pi.registerTool({ ...tool, parameters: frozenParameters(tool.parameters) });
    },
    seal() {
      sealed = true;
    },
    names: () => names,
  };
}
