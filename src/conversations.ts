import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { isRecord } from "./utils";

export const ConversationMetaSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  cwd: Type.String(),
  spaceRoot: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  lastSettledAt: Type.Optional(Type.String()),
});

export type ConversationMeta = Static<typeof ConversationMetaSchema>;

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

async function readIndex(): Promise<ConversationIndex> {
  try {
    const parsed = JSON.parse(await readFile(CONVERSATION_INDEX_PATH, "utf8")) as unknown;
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

async function writeIndex(index: ConversationIndex): Promise<void> {
  await mkdir(dirname(CONVERSATION_INDEX_PATH), { recursive: true });
  await writeFile(CONVERSATION_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function buildConversationMeta(
  ctx: ExtensionContext,
  existing: ConversationMeta | undefined,
  update: ConversationUpdate = {},
  write: boolean,
): ConversationMeta {
  const sessionId = ctx.sessionManager.getSessionId();
  const now = new Date().toISOString();
  const sessionName = cleaned(ctx.sessionManager.getSessionName());
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    id: existing?.id ?? sessionId,
    sessionId,
    sessionFile,
    name: cleaned(update.name) ?? existing?.name ?? sessionName,
    description: cleaned(update.description) ?? existing?.description,
    cwd: ctx.sessionManager.getCwd(),
    spaceRoot: update.spaceRoot === null ? undefined : update.spaceRoot ?? existing?.spaceRoot,
    createdAt: existing?.createdAt ?? now,
    updatedAt: write ? now : existing?.updatedAt ?? now,
    lastSettledAt: update.settledAt ?? existing?.lastSettledAt,
  };
}

export async function readCurrentConversation(
  ctx: ExtensionContext,
  update: ConversationUpdate = {},
): Promise<ConversationMeta> {
  const sessionId = ctx.sessionManager.getSessionId();
  const index = await readIndex();
  return buildConversationMeta(ctx, index.conversations[sessionId], update, false);
}

export async function upsertCurrentConversation(
  ctx: ExtensionContext,
  update: ConversationUpdate = {},
): Promise<ConversationMeta> {
  const sessionId = ctx.sessionManager.getSessionId();
  const index = await readIndex();
  const next = buildConversationMeta(ctx, index.conversations[sessionId], update, true);

  index.conversations[next.id] = next;
  await writeIndex(index);
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
