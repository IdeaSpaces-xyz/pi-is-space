import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./utils";

export type ConversationMeta = {
  id: string;
  sessionId: string;
  sessionFile?: string;
  name?: string;
  description?: string;
  cwd: string;
  spaceRoot?: string;
  createdAt: string;
  updatedAt: string;
  lastSettledAt?: string;
};

type ConversationIndex = {
  version: 1;
  conversations: Record<string, ConversationMeta>;
};

export type ConversationUpdate = {
  name?: string;
  description?: string;
  spaceRoot?: string | null;
  settledAt?: string;
};

export const CONVERSATION_INDEX_PATH = join(homedir(), ".ideaspaces", "pi", "conversations.json");

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readConversationMeta(value: unknown): ConversationMeta | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const sessionId = stringField(value, "sessionId");
  const cwd = stringField(value, "cwd");
  const createdAt = stringField(value, "createdAt");
  const updatedAt = stringField(value, "updatedAt");
  if (!id || !sessionId || !cwd || !createdAt || !updatedAt) return null;

  return {
    id,
    sessionId,
    sessionFile: stringField(value, "sessionFile"),
    name: stringField(value, "name"),
    description: stringField(value, "description"),
    cwd,
    spaceRoot: stringField(value, "spaceRoot"),
    createdAt,
    updatedAt,
    lastSettledAt: stringField(value, "lastSettledAt"),
  };
}

function readIndex(): ConversationIndex {
  if (!existsSync(CONVERSATION_INDEX_PATH)) {
    return { version: 1, conversations: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(CONVERSATION_INDEX_PATH, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.conversations)) {
      return { version: 1, conversations: {} };
    }

    const conversations: Record<string, ConversationMeta> = {};
    for (const [id, value] of Object.entries(parsed.conversations)) {
      const meta = readConversationMeta(value);
      if (meta) conversations[id] = meta;
    }
    return { version: 1, conversations };
  } catch {
    return { version: 1, conversations: {} };
  }
}

function writeIndex(index: ConversationIndex): void {
  mkdirSync(dirname(CONVERSATION_INDEX_PATH), { recursive: true });
  writeFileSync(CONVERSATION_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function upsertCurrentConversation(
  ctx: ExtensionContext,
  update: ConversationUpdate = {},
): ConversationMeta {
  const sessionId = ctx.sessionManager.getSessionId();
  const now = new Date().toISOString();
  const index = readIndex();
  const existing = index.conversations[sessionId];
  const sessionName = cleaned(ctx.sessionManager.getSessionName());
  const sessionFile = ctx.sessionManager.getSessionFile();
  const next: ConversationMeta = {
    id: existing?.id ?? sessionId,
    sessionId,
    sessionFile,
    name: cleaned(update.name) ?? existing?.name ?? sessionName,
    description: cleaned(update.description) ?? existing?.description,
    cwd: ctx.sessionManager.getCwd(),
    spaceRoot: update.spaceRoot === null ? undefined : update.spaceRoot ?? existing?.spaceRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSettledAt: update.settledAt ?? existing?.lastSettledAt,
  };

  index.conversations[next.id] = next;
  writeIndex(index);
  return next;
}

export function formatConversationMeta(meta: ConversationMeta): string {
  return [
    `conversation: ${meta.name ?? "(unnamed)"}`,
    `id:           ${meta.id}`,
    `description:  ${meta.description ?? "(none)"}`,
    `cwd:          ${meta.cwd}`,
    `space root:   ${meta.spaceRoot ?? "(none detected)"}`,
    `session id:   ${meta.sessionId}`,
    `session file: ${meta.sessionFile ?? "(ephemeral)"}`,
    `last settled: ${meta.lastSettledAt ?? "(never)"}`,
    `index:        ${CONVERSATION_INDEX_PATH}`,
  ].join("\n");
}
