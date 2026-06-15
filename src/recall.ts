import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ConversationMeta } from "./conversations";
import { isRecord } from "./utils";

export type RecallScope = "branch" | "all" | "compacted";

export type RecallMap = {
  conversation: ConversationMeta;
  session: {
    id: string;
    file?: string;
    cwd: string;
    leafId?: string;
  };
  counts: {
    entries: number;
    branchEntries: number;
    compactions: number;
    settleCompactions: number;
    branchSummaries: number;
    labels: number;
    compactedEntries: number;
  };
  activeWindow?: {
    compactionId: string;
    firstKeptEntryId: string;
    timestamp: string;
    summary: string;
  };
  compactions: RecallCompaction[];
  branchSummaries: RecallBranchSummary[];
  labels: RecallLabel[];
};

type RecallCompaction = {
  id: string;
  timestamp: string;
  firstKeptEntryId: string;
  settle: boolean;
  checkpointEntryId?: string;
  conversationId?: string;
  captures: string[];
  summary: string;
};

type RecallBranchSummary = {
  id: string;
  timestamp: string;
  fromId: string;
  summary: string;
};

type RecallLabel = {
  id: string;
  label: string;
  timestamp: string;
  kind: string;
};

type RecallSearchHit = {
  id: string;
  timestamp: string;
  kind: string;
  score: number;
  preview: string;
};

// FIXME(#29): Interim adapter over Pi's SessionManager. Pi exposes entries/tree/branch but not
// higher-level conversation map/search/range helpers yet; keep this deterministic
// and local until those APIs exist lower in the stack.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PREVIEW_CHARS = 220;
const EXCERPT_CHARS = 4000;

function cleanLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function oneLine(text: string, max = PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function truncateBlock(text: string, max = EXCERPT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n[truncated ${trimmed.length - max} chars]`;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
    else if (block.type === "toolCall" && typeof block.name === "string") parts.push(`[toolCall ${block.name}]`);
  }
  return parts.join("\n");
}

function messageText(entry: SessionMessageEntry): string {
  const message = entry.message;
  switch (message.role) {
    case "user":
    case "assistant":
      return textContent(message.content);
    case "toolResult":
      return [`tool: ${message.toolName}`, textContent(message.content)].filter(Boolean).join("\n");
    case "bashExecution":
      return [`$ ${message.command}`, message.output].filter(Boolean).join("\n");
    case "custom":
      return textContent(message.content);
    case "branchSummary":
      return message.summary;
    case "compactionSummary":
      return message.summary;
    default:
      return "";
  }
}

function entryKind(entry: SessionEntry): string {
  if (entry.type === "message") return entry.message.role;
  return entry.type;
}

function entryText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message":
      return messageText(entry);
    case "compaction":
      return entry.summary;
    case "branch_summary":
      return entry.summary;
    case "custom_message":
      return textContent(entry.content);
    case "custom":
      return JSON.stringify(entry.data ?? {}, null, 2);
    case "label":
      return entry.label ? `label ${entry.label} -> ${entry.targetId}` : `clear label -> ${entry.targetId}`;
    case "session_info":
      return entry.name ? `session name: ${entry.name}` : "session name cleared";
    case "model_change":
      return `model: ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `thinking level: ${entry.thinkingLevel}`;
    default:
      return "";
  }
}

function detailsRecord(entry: { details?: unknown }): Record<string, unknown> | undefined {
  return isRecord(entry.details) ? entry.details : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function capturePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item === "string") paths.push(item);
    else if (isRecord(item) && typeof item.path === "string") paths.push(item.path);
  }
  return paths;
}

function compactionInfo(entry: SessionEntry): RecallCompaction | null {
  if (entry.type !== "compaction") return null;
  const details = detailsRecord(entry);
  const settle = details?.kind === "is-settle";
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    firstKeptEntryId: entry.firstKeptEntryId,
    settle,
    checkpointEntryId: typeof details?.checkpointEntryId === "string" ? details.checkpointEntryId : undefined,
    conversationId: typeof details?.conversationId === "string" ? details.conversationId : undefined,
    captures: capturePaths(details?.captures),
    summary: oneLine(entry.summary, 260),
  };
}

function branchSummaryInfo(entry: SessionEntry): RecallBranchSummary | null {
  if (entry.type !== "branch_summary") return null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    fromId: entry.fromId,
    summary: oneLine(entry.summary, 260),
  };
}

function latestCompaction(branch: SessionEntry[]): RecallCompaction | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const info = compactionInfo(branch[i]);
    if (info) return info;
  }
  return undefined;
}

function compactedEntryIds(branch: SessionEntry[]): Set<string> {
  const latest = latestCompaction(branch);
  if (!latest) return new Set();
  const ids = new Set<string>();
  let beforeFirstKept = true;
  for (const entry of branch) {
    // Entries before firstKeptEntryId are compacted; firstKeptEntryId..compactionId is the kept active window.
    if (entry.id === latest.firstKeptEntryId) beforeFirstKept = false;
    if (entry.id === latest.id) break;
    if (beforeFirstKept) ids.add(entry.id);
  }
  return ids;
}

function getEntriesForScope(ctx: ExtensionContext, scope: RecallScope): SessionEntry[] {
  if (scope === "all") return ctx.sessionManager.getEntries();
  const branch = ctx.sessionManager.getBranch();
  if (scope === "branch") return branch;
  const compacted = compactedEntryIds(branch);
  return branch.filter((entry) => compacted.has(entry.id));
}

function scoreMatch(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (lower === q) return 100;
  if (lower.includes(q)) return 50 + Math.min(25, q.length);
  return 0;
}

function formatCompactions(compactions: RecallCompaction[]): string {
  if (!compactions.length) return "- (none)";
  return compactions
    .map((c) => {
      const bits = [`- ${c.id}`, c.settle ? "settle" : "compact", c.timestamp, `firstKept=${c.firstKeptEntryId}`];
      if (c.checkpointEntryId) bits.push(`checkpoint=${c.checkpointEntryId}`);
      if (c.captures.length) bits.push(`captures=${c.captures.join(",")}`);
      return `${bits.join(" · ")}\n  ${c.summary}`;
    })
    .join("\n");
}

function formatBranchSummaries(summaries: RecallBranchSummary[]): string {
  if (!summaries.length) return "- (none)";
  return summaries.map((s) => `- ${s.id} · ${s.timestamp} · from=${s.fromId}\n  ${s.summary}`).join("\n");
}

function formatLabels(labels: RecallLabel[]): string {
  if (!labels.length) return "- (none)";
  return labels.map((l) => `- ${l.id} · ${l.kind} · ${l.label}`).join("\n");
}

export function buildRecallMap(ctx: ExtensionContext, conversation: ConversationMeta): RecallMap {
  const entries = ctx.sessionManager.getEntries();
  const branch = ctx.sessionManager.getBranch();
  const compactions = branch.map(compactionInfo).filter((item): item is RecallCompaction => item !== null);
  const branchSummaries = branch.map(branchSummaryInfo).filter((item): item is RecallBranchSummary => item !== null);
  const compacted = compactedEntryIds(branch);
  const labels: RecallLabel[] = [];
  // SessionManager currently exposes labels per entry; switch to a bulk label API if Pi adds one.
  for (const entry of entries) {
    const label = ctx.sessionManager.getLabel(entry.id);
    if (label) labels.push({ id: entry.id, label, timestamp: entry.timestamp, kind: entryKind(entry) });
  }
  const active = latestCompaction(branch);

  return {
    conversation,
    session: {
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      cwd: ctx.sessionManager.getCwd(),
      leafId: ctx.sessionManager.getLeafId() ?? undefined,
    },
    counts: {
      entries: entries.length,
      branchEntries: branch.length,
      compactions: compactions.length,
      settleCompactions: compactions.filter((c) => c.settle).length,
      branchSummaries: branchSummaries.length,
      labels: labels.length,
      compactedEntries: compacted.size,
    },
    activeWindow: active
      ? {
          compactionId: active.id,
          firstKeptEntryId: active.firstKeptEntryId,
          timestamp: active.timestamp,
          summary: active.summary,
        }
      : undefined,
    compactions,
    branchSummaries,
    labels,
  };
}

export function formatRecallMap(map: RecallMap): string {
  const lines = [
    "# Conversation recall map",
    "",
    `conversation: ${map.conversation.name ?? "(unnamed)"}`,
    `conversation id: ${map.conversation.id}`,
    `description: ${map.conversation.description ?? "(none)"}`,
    `session id: ${map.session.id}`,
    `session file: ${map.session.file ?? "(ephemeral)"}`,
    `cwd: ${map.session.cwd}`,
    `leaf: ${map.session.leafId ?? "(none)"}`,
    "",
    "## Counts",
    `entries: ${map.counts.entries}`,
    `branch entries: ${map.counts.branchEntries}`,
    `compactions: ${map.counts.compactions} (${map.counts.settleCompactions} settle)`,
    `branch summaries: ${map.counts.branchSummaries}`,
    `labels: ${map.counts.labels}`,
    `compacted entries on active branch: ${map.counts.compactedEntries}`,
    "",
    "## Active window",
  ];
  if (map.activeWindow) {
    lines.push(
      `compaction: ${map.activeWindow.compactionId}`,
      `first kept: ${map.activeWindow.firstKeptEntryId}`,
      `timestamp: ${map.activeWindow.timestamp}`,
      `summary: ${map.activeWindow.summary}`,
    );
  } else {
    lines.push("(no compaction on active branch)");
  }
  lines.push("", "## Compactions", formatCompactions(map.compactions));
  lines.push("", "## Branch summaries", formatBranchSummaries(map.branchSummaries));
  lines.push("", "## Labels", formatLabels(map.labels));
  lines.push(
    "",
    "## Recall handles",
    "- search: is_recall({ action: \"search\", query: \"...\" })",
    "- excerpt: is_recall({ action: \"excerpt\", entryId: \"...\" })",
    "- range: is_recall({ action: \"excerpt\", fromId: \"...\", toId: \"...\" })",
  );
  return lines.join("\n");
}

export function searchRecall(ctx: ExtensionContext, query: string, scope: RecallScope = "branch", limit?: number): RecallSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const entries = getEntriesForScope(ctx, scope);
  const hits: RecallSearchHit[] = [];
  for (const entry of entries) {
    const text = entryText(entry);
    const score = scoreMatch(text, q);
    if (!score) continue;
    hits.push({ id: entry.id, timestamp: entry.timestamp, kind: entryKind(entry), score, preview: oneLine(text) });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
    .slice(0, cleanLimit(limit));
}

export function formatRecallSearch(query: string, scope: RecallScope, hits: RecallSearchHit[]): string {
  const lines = [`# Recall search`, "", `query: ${query}`, `scope: ${scope}`, `hits: ${hits.length}`, ""];
  if (!hits.length) {
    lines.push("No matches.");
    return lines.join("\n");
  }
  for (const hit of hits) {
    lines.push(`- ${hit.id} · ${hit.kind} · ${hit.timestamp}`, `  ${hit.preview}`);
  }
  return lines.join("\n");
}

function pathBetween(branch: SessionEntry[], fromId: string, toId: string): SessionEntry[] {
  const fromIndex = branch.findIndex((entry) => entry.id === fromId);
  const toIndex = branch.findIndex((entry) => entry.id === toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) return [];
  return branch.slice(fromIndex, toIndex + 1);
}

function formatEntryExcerpt(entry: SessionEntry): string {
  const label = `${entry.id} · ${entryKind(entry)} · ${entry.timestamp}`;
  return `## ${label}\n\n${truncateBlock(entryText(entry))}`;
}

export function excerptRecall(ctx: ExtensionContext, entryId?: string, fromId?: string, toId?: string): string | null {
  if (entryId) {
    const entry = ctx.sessionManager.getEntry(entryId);
    return entry ? formatEntryExcerpt(entry) : null;
  }

  if (!fromId || !toId) return null;
  const entries = pathBetween(ctx.sessionManager.getBranch(), fromId, toId);
  if (!entries.length) return null;
  return [`# Recall excerpt`, "", `range: ${fromId}..${toId}`, "", ...entries.map(formatEntryExcerpt)].join("\n");
}

export function cleanRecallScope(value: string | undefined): RecallScope {
  if (value === "all" || value === "compacted" || value === "branch") return value;
  return "branch";
}
