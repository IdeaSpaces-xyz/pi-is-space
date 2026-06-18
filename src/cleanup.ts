import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConversationMeta } from "./conversations";
import { isRecord } from "./utils";

export type CaptureRef = {
  path: string;
  name?: string;
  summary?: string;
  sha?: string;
};

export type ContextUsageSnapshot = {
  tokens?: number;
  percent?: number;
  contextWindow?: number;
};

export type CleanupScope = "active-window";

export type CleanupRequest = {
  id: string;
  scope: CleanupScope;
  conversation: ConversationMeta;
  checkpoint: string;
  keep?: string;
  drop?: string;
  captures: CaptureRef[];
  requestedAt: string;
  firstEntryId?: string;
  leafIdAtRequest?: string;
  usageBefore?: ContextUsageSnapshot;
  entriesBeforeCleanup?: number;
};

export const CLEANUP_LABEL = "is-cleanup";
export const CLEANUP_BRANCH_SUMMARY_LABEL = "is-cleanup-branch-summary";
export const CLEANUP_CHECKPOINT_LABEL = "is-cleanup checkpoint";
export const CLEANUP_FIRST_KEPT_LABEL = "is-cleanup kept-from";

export type CleanupCompactionDetails = {
  kind: "is-cleanup";
  scope: CleanupScope;
  conversationId: string;
  checkpointEntryId: string;
  firstKeptEntryId?: string;
  captures: CaptureRef[];
  usageBefore?: ContextUsageSnapshot;
  entriesBeforeCleanup?: number;
};

export function dedupeCaptures(captures: CaptureRef[]): CaptureRef[] {
  const seen = new Set<string>();
  const result: CaptureRef[] = [];
  for (const capture of captures) {
    const key = capture.path;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capture);
  }
  return result;
}

export function captureRefsFromPaths(paths: string[]): CaptureRef[] {
  return paths.map((path) => ({ path }));
}

export function formatCaptureRefs(captures: CaptureRef[]): string {
  if (!captures.length) return "- (none recorded)";
  return captures
    .map((capture) => {
      const suffix = capture.summary ? ` — ${capture.summary}` : "";
      const sha = capture.sha ? ` (${capture.sha.slice(0, 12)})` : "";
      return `- ${capture.path}${suffix}${sha}`;
    })
    .join("\n");
}

export function formatContextUsage(usage: ContextUsageSnapshot | undefined): string {
  if (!usage) return "- current context: unknown";
  const parts: string[] = [];
  if (usage.tokens !== undefined) parts.push(`${Math.round(usage.tokens).toLocaleString()} tokens`);
  if (usage.percent !== undefined) parts.push(`${usage.percent.toFixed(1)}%`);
  if (usage.contextWindow !== undefined) parts.push(`window ${Math.round(usage.contextWindow).toLocaleString()}`);
  return `- current context: ${parts.length ? parts.join(" / ") : "unknown"}`;
}

export function formatCleanupCheckpoint(request: CleanupRequest): string {
  const lines = [
    "[IdeaSpaces context checkpoint]",
    "",
    `Conversation: ${request.conversation.name ?? "(unnamed)"}`,
    `Conversation-Id: ${request.conversation.id}`,
    `Cleanup-Scope: ${request.scope}`,
    "",
    "Context state now:",
    request.checkpoint.trim(),
  ];
  if (request.keep?.trim()) lines.push("", "Keep active:", request.keep.trim());
  if (request.drop?.trim()) lines.push("", "Dropped from active context:", request.drop.trim());
  if (request.captures.length) lines.push("", "Durable captures represented:", formatCaptureRefs(request.captures));
  return lines.join("\n");
}

export function formatCleanupPreview(request: CleanupRequest): string {
  const compactedEntries = request.entriesBeforeCleanup ?? 0;
  const lines = [
    "# Cleanup preview",
    "",
    `conversation: ${request.conversation.name ?? "(unnamed)"}`,
    `conversation id: ${request.conversation.id}`,
    `scope: ${request.scope}`,
    "",
    "## Current context",
    formatContextUsage(request.usageBefore),
    `- branch entries at preview time: ${compactedEntries.toLocaleString()}`,
    "",
    "## Cleanup plan",
    `- ${request.scope} cleanup: compact prior raw conversation before the cleanup checkpoint`,
    "- preserve selected live state in the checkpoint below",
    "- label cleanup anchors for /tree navigation",
    "- keep full raw history recoverable through /tree and is_recall",
    "",
    "## Estimated savings",
    `- will compact roughly ${compactedEntries.toLocaleString()} current branch entries before the cleanup checkpoint`,
    "- expected to remove most current conversation/process tokens from active context",
    "- exact post-cleanup footer usage is known after compaction and the next model response",
    "",
    "## Keep live",
    request.checkpoint.trim(),
  ];
  if (request.keep?.trim()) lines.push("", request.keep.trim());
  lines.push("", "## Drop from active context", request.drop?.trim() || "- (not specified; fill this before applying cleanup if anything specific should leave)");
  if (request.captures.length) lines.push("", "## Durable captures represented", formatCaptureRefs(request.captures));
  lines.push("", "Apply only after the user confirms this cleanup plan.");
  return lines.join("\n");
}

export function formatCleanupSummary(request: CleanupRequest): string {
  const lines = [
    "Prior conversation process was cleaned out of active context. This is context cleanup, not a shared-state capture.",
    "",
    `Conversation: ${request.conversation.name ?? "(unnamed)"}`,
    `Conversation-Id: ${request.conversation.id}`,
    `Cleanup-Scope: ${request.scope}`,
    "",
    "Checkpoint:",
    request.checkpoint.trim(),
  ];
  if (request.keep?.trim()) lines.push("", "Still active:", request.keep.trim());
  if (request.drop?.trim()) lines.push("", "Intentionally omitted from active context:", request.drop.trim());
  if (request.captures.length) lines.push("", "Durable captures represented:", formatCaptureRefs(request.captures));
  lines.push("", "The raw process remains in the local Pi JSONL session tree and can be revisited via /tree or is_recall.");
  return lines.join("\n");
}

// Compaction entries are validated here separately from CleanupDetailsSchema in index.ts,
// which validates is_cleanup tool-result messages before the compaction entry exists.
export function cleanupDetailsFromEntry(entry: SessionEntry): CleanupCompactionDetails | null {
  if (entry.type !== "compaction") return null;
  const details = isRecord(entry.details) ? entry.details : undefined;
  if (!details || details.kind !== "is-cleanup") return null;
  if (details.scope !== "active-window") return null;
  return {
    kind: "is-cleanup",
    scope: "active-window",
    conversationId: typeof details.conversationId === "string" ? details.conversationId : "",
    checkpointEntryId: typeof details.checkpointEntryId === "string" ? details.checkpointEntryId : "",
    // Older cleanup entries may not carry firstKeptEntryId in details; the compaction entry itself is authoritative.
    firstKeptEntryId: typeof details.firstKeptEntryId === "string" ? details.firstKeptEntryId : entry.firstKeptEntryId,
    captures: capturePathsToRefs(details.captures),
    usageBefore: isContextUsageSnapshot(details.usageBefore) ? details.usageBefore : undefined,
    entriesBeforeCleanup: typeof details.entriesBeforeCleanup === "number" ? details.entriesBeforeCleanup : undefined,
  };
}

export function formatCleanupBranchSummary(entries: SessionEntry[]): string | null {
  const cleanupEntries = entries.flatMap((entry) => {
    const details = cleanupDetailsFromEntry(entry);
    return details && entry.type === "compaction" ? [{ entry, details }] : [];
  });
  if (!cleanupEntries.length) return null;

  const { entry: latest, details: latestDetails } = cleanupEntries[cleanupEntries.length - 1];
  const summary = (latest.summary ?? "").trim();
  const allCaptures = dedupeCaptures(cleanupEntries.flatMap((item) => item.details.captures));
  const cleanupCountLine = cleanupEntries.length === 1
    ? "- [x] The abandoned branch contains an IdeaSpaces cleanup compaction."
    : `- [x] The abandoned branch contains ${cleanupEntries.length} IdeaSpaces cleanup compactions.`;

  const lines = [
    "## Goal",
    "Preserve the relevant state from a branch that included IdeaSpaces context cleanup.",
    "",
    "## Progress",
    "### Done",
    cleanupCountLine,
    "- [x] Raw process remains available in the Pi session tree and via is_recall.",
    "",
    "## Critical Context",
    summary || "(cleanup summary was empty)",
    "",
    "## Cleanup Anchors",
    `- compaction: ${latest.id}`,
  ];
  if (latestDetails.firstKeptEntryId) lines.push(`- first kept: ${latestDetails.firstKeptEntryId}`);
  if (latestDetails.checkpointEntryId) lines.push(`- checkpoint: ${latestDetails.checkpointEntryId}`);
  if (allCaptures.length) lines.push("", "## Durable Captures", formatCaptureRefs(allCaptures));
  return lines.join("\n");
}

function capturePathsToRefs(value: unknown): CaptureRef[] {
  if (!Array.isArray(value)) return [];
  const captures: CaptureRef[] = [];
  for (const item of value) {
    if (typeof item === "string") captures.push({ path: item });
    else if (isRecord(item) && typeof item.path === "string") {
      captures.push({
        path: item.path,
        name: typeof item.name === "string" ? item.name : undefined,
        summary: typeof item.summary === "string" ? item.summary : undefined,
        sha: typeof item.sha === "string" ? item.sha : undefined,
      });
    }
  }
  return captures;
}

function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value.tokens === undefined || typeof value.tokens === "number") &&
    (value.percent === undefined || typeof value.percent === "number") &&
    (value.contextWindow === undefined || typeof value.contextWindow === "number")
  );
}
