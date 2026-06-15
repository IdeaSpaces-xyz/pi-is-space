import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSpaceRoot,
  assembleAwareness,
  gitState,
  walkPathContext,
  spaceRootLevel,
  currentBranchLevel,
} from "@ideaspaces/sdk";
import {
  type ConversationMeta,
  formatConversationMeta,
  readCurrentConversation,
  upsertCurrentConversation,
} from "./conversations";
import { isRecord } from "./utils";

type CliResult = { out: string; err: string; code: number };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type JsonCliResult<T> =
  | { ok: true; data: T; text: string }
  | { ok: false; error: string; text: string };

type CaptureStatus = {
  repoRoot: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  untracked_in_tracked_dirs: string[];
  tracked_captures: string[];
};

type SyncDryRun = {
  /** Mirrors the CLI JSON shape for `ideaspaces sync --dry-run`. */
  dry_run: true;
  upstream: string | null;
  ahead: number;
  behind: number;
};

type CreatePlanStep = {
  op: string;
  path?: string;
  detail?: string;
};

type CreatePlan = {
  target: string;
  shape: "greenfield" | "content-existing" | "code-repo" | "old-shape" | "complete";
  privateAgent: boolean;
  plan: CreatePlanStep[];
};

type CreateResult = {
  target: string;
  shape: string;
  privateAgent: boolean;
  scaffolded: true;
};

type PublishResult = {
  repo_id: string;
  slug: string;
  namespace: string;
  remote_url: string;
  web_url: string;
  identity_email: string;
};

type AtMention = {
  prefix: string;
  query: string;
  quoted: boolean;
};

type FileSuggestion = {
  path: string;
  isDirectory: boolean;
  score: number;
};

type CaptureRef = {
  path: string;
  name?: string;
  summary?: string;
  sha?: string;
};

type SettleRequest = {
  id: string;
  conversation: ConversationMeta;
  checkpoint: string;
  keep?: string;
  drop?: string;
  captures: CaptureRef[];
  requestedAt: string;
  firstEntryId?: string;
  leafIdAtRequest?: string;
};

type IsWriteOutput = {
  path?: string;
  sha?: string;
  commit_sha?: string;
};

type SettleToolResultEntry = SessionMessageEntry & {
  message: {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    details?: unknown;
  };
};

const CaptureRefSchema = Type.Object({
  path: Type.String(),
  name: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  sha: Type.Optional(Type.String()),
});

const ConversationMetaSchema = Type.Object({
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

const SettleDetailsSchema = Type.Object({
  kind: Type.Literal("is-settle"),
  request: Type.Object({
    id: Type.String(),
    conversation: ConversationMetaSchema,
    checkpoint: Type.String(),
    keep: Type.Optional(Type.String()),
    drop: Type.Optional(Type.String()),
    captures: Type.Array(CaptureRefSchema),
    requestedAt: Type.String(),
    firstEntryId: Type.Optional(Type.String()),
    leafIdAtRequest: Type.Optional(Type.String()),
  }),
});

type SettleDetails = Static<typeof SettleDetailsSchema>;

const AUTOCOMPLETE_LIMIT = 20;
const AUTOCOMPLETE_FD_LIMIT = 1000;
const AUTOCOMPLETE_EXCLUDES = [".git", "node_modules", "backups", ".pi", ".claude"];

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

function isErrorResult(result: ToolResult): boolean {
  return result.isError === true;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function extractAtMention(textBeforeCursor: string): AtMention | null {
  const quoted = textBeforeCursor.match(/(?:^|\s)(@"[^"]*)$/);
  if (quoted?.[1]) {
    return { prefix: quoted[1], query: quoted[1].slice(2), quoted: true };
  }

  const unquoted = textBeforeCursor.match(/(?:^|\s)(@[^\s"]*)$/);
  if (unquoted?.[1]) {
    return { prefix: unquoted[1], query: unquoted[1].slice(1), quoted: false };
  }

  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
  const normalized = toPosixPath(query);
  if (!normalized.includes("/")) return normalized;

  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return normalized;

  let pattern = trimmed
    .split("/")
    .filter(Boolean)
    .map((segment) => escapeRegex(segment))
    .join("[\\\\/]");
  if (hasTrailingSeparator) pattern += "[\\\\/]";
  return pattern;
}

function resolveScopedQuery(root: string, rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
  const normalizedQuery = toPosixPath(rawQuery).replace(/^\.\//, "");
  const slashIndex = normalizedQuery.lastIndexOf("/");
  if (slashIndex === -1) return null;

  const displayBase = normalizedQuery.slice(0, slashIndex + 1);
  const query = normalizedQuery.slice(slashIndex + 1);
  let baseDir: string;
  if (displayBase.startsWith("~/")) {
    baseDir = join(homedir(), displayBase.slice(2));
  } else if (displayBase.startsWith("/")) {
    baseDir = displayBase;
  } else {
    baseDir = join(root, displayBase);
  }

  try {
    if (!statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }

  return { baseDir, query, displayBase };
}

function scopedPathForDisplay(displayBase: string, path: string): string {
  if (displayBase === "/") return `/${path}`;
  return `${displayBase}${path}`;
}

function scorePath(path: string, query: string, isDirectory: boolean): number {
  if (!query) return isDirectory ? 2 : 1;

  const lowerPath = path.toLowerCase();
  const lowerName = basename(path).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;

  if (lowerName === lowerQuery) score = 100;
  else if (lowerName.startsWith(lowerQuery)) score = 80;
  else if (lowerName.includes(lowerQuery)) score = 50;
  else if (lowerPath.includes(lowerQuery)) score = 30;

  return isDirectory && score > 0 ? score + 10 : score;
}

function formatAutocompleteValue(path: string, isDirectory: boolean, quoted: boolean): string {
  const completionPath = isDirectory ? `${path}/` : path;
  if (!quoted && !completionPath.includes(" ")) return `@${completionPath}`;
  return `@"${completionPath}"`;
}

function resolveFdCommand(): string | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const bundledFd = join(agentDir, "bin", process.platform === "win32" ? "fd.exe" : "fd");
  if (existsSync(bundledFd)) return bundledFd;
  return "fd";
}

async function collectFileSuggestions(
  pi: ExtensionAPI,
  fdCommand: string,
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<FileSuggestion[] | undefined> {
  const normalizedQuery = toPosixPath(query).replace(/^\.\//, "");
  const scopedQuery = resolveScopedQuery(root, normalizedQuery);
  const fdBaseDir = scopedQuery?.baseDir ?? root;
  const fdQuery = scopedQuery?.query ?? normalizedQuery;
  const args = [
    "--base-directory",
    fdBaseDir,
    "--max-results",
    String(AUTOCOMPLETE_FD_LIMIT),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--no-ignore",
    "--no-ignore-vcs",
    "--no-ignore-parent",
  ];

  for (const exclude of AUTOCOMPLETE_EXCLUDES) {
    args.push("--exclude", exclude, "--exclude", `${exclude}/*`, "--exclude", `${exclude}/**`);
  }

  if (fdQuery.includes("/")) args.push("--full-path");
  if (fdQuery) args.push(buildFdPathQuery(fdQuery));

  const result = await pi.exec(fdCommand, args, { signal, timeout: 5_000 });
  if (result.code !== 0) return undefined;
  if (!result.stdout) return [];

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = toPosixPath(line);
      const isDirectory = path.endsWith("/");
      const normalizedPath = isDirectory ? path.slice(0, -1) : path;
      const displayPath = scopedQuery ? scopedPathForDisplay(scopedQuery.displayBase, normalizedPath) : normalizedPath;
      return {
        path: displayPath,
        isDirectory,
        score: scorePath(normalizedPath, fdQuery, isDirectory),
      };
    })
    .filter((suggestion) => suggestion.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, AUTOCOMPLETE_LIMIT);
}

function resolveCli(): string {
  if (process.env.IS_CLI_PATH) return process.env.IS_CLI_PATH;

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Monorepo local dev: pi-is-space/src/index.ts → ../../cli/bundle/ideaspaces.js
  const local = resolvePath(__dirname, "../../cli/bundle/ideaspaces.js");
  if (existsSync(local)) return local;

  // Installed package: walk upward looking for node_modules/@ideaspaces/cli.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = resolvePath(
      dir,
      "node_modules/@ideaspaces/cli/bundle/ideaspaces.js",
    );
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Final fallback: rely on ideaspaces being available on PATH.
  return "ideaspaces";
}

const CLI = resolveCli();

// Make the resolved CLI discoverable to skills that invoke Bash. If CLI is a
// PATH command this is harmless; skills check that the path exists before using
// `node "$IS_CLI_PATH"`.
if (!process.env.IS_CLI_PATH) process.env.IS_CLI_PATH = CLI;

function isCliFile(): boolean {
  return CLI.includes("/") || CLI.includes("\\") || CLI.endsWith(".js");
}

// The "last seen" marker — HEAD at the end of the previous session — lives in a
// local git ref, not a file in HOME. update-ref is atomic, local refs aren't
// pushed, and `recentActivity` diffs HEAD against it for the since-last-session
// view. (Replaces the SDK session-state file.)
const SEEN_REF = "refs/ideaspaces/seen";

function readSeenMarker(cwd: string): string | undefined {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", SEEN_REF], {
    encoding: "utf-8",
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

function setSeenMarker(cwd: string, sha: string): void {
  // Best-effort: a failed marker update must never break the session.
  spawnSync("git", ["-C", cwd, "update-ref", SEEN_REF, sha], { encoding: "utf-8" });
}

function cli(args: string[], stdin?: string, cwd?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(isCliFile() ? "node" : CLI, isCliFile() ? [CLI, ...args] : args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd || undefined,
    });

    let out = "";
    let err = "";

    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", (code) => resolve({ out, err, code: code ?? 1 }));
    proc.on("error", (e) => resolve({ out: "", err: e.message, code: 1 }));

    if (stdin != null) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

async function run(args: string[], stdin?: string, cwd?: string): Promise<ToolResult> {
  const { out, err, code } = await cli(["--json", ...args], stdin, cwd);
  if (code !== 0) return fail(err.trim() || out.trim() || `Exit ${code}`);
  return ok(out.trim() || err.trim() || "Done");
}

async function runJson<T>(args: string[], cwd?: string): Promise<JsonCliResult<T>> {
  const { out, err, code } = await cli(["--json", ...args], undefined, cwd);
  const text = out.trim() || err.trim();
  if (code !== 0) return { ok: false, error: err.trim() || out.trim() || `Exit ${code}`, text };

  try {
    return { ok: true, data: JSON.parse(out) as T, text };
  } catch {
    return { ok: false, error: `Expected JSON from ideaspaces ${args.join(" ")}`, text };
  }
}

function formatPathList(paths: string[], max = 8): string {
  const head = paths.slice(0, max).map((path) => `  ${path}`);
  if (paths.length > max) head.push(`  ... and ${paths.length - max} more`);
  return head.join("\n");
}

function isWriteOutputFromUnknown(value: unknown): IsWriteOutput | null {
  if (!isRecord(value)) return null;
  return {
    path: typeof value.path === "string" ? value.path : undefined,
    sha: typeof value.sha === "string" ? value.sha : undefined,
    commit_sha: typeof value.commit_sha === "string" ? value.commit_sha : undefined,
  };
}

function parseIsWriteOutput(text: string): IsWriteOutput | null {
  try {
    return isWriteOutputFromUnknown(JSON.parse(text));
  } catch {
    return null;
  }
}

function dedupeCaptures(captures: CaptureRef[]): CaptureRef[] {
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

function captureRefsFromPaths(paths: string[]): CaptureRef[] {
  return paths.map((path) => ({ path }));
}

function formatCaptureRefs(captures: CaptureRef[]): string {
  if (!captures.length) return "- (none recorded)";
  return captures
    .map((capture) => {
      const suffix = capture.summary ? ` — ${capture.summary}` : "";
      const sha = capture.sha ? ` (${capture.sha.slice(0, 12)})` : "";
      return `- ${capture.path}${suffix}${sha}`;
    })
    .join("\n");
}

function formatSettleCheckpoint(request: SettleRequest): string {
  const lines = [
    "[IdeaSpaces context checkpoint]",
    "",
    `Conversation: ${request.conversation.name ?? "(unnamed)"}`,
    `Conversation-Id: ${request.conversation.id}`,
    "",
    "Captured durable state:",
    formatCaptureRefs(request.captures),
    "",
    "Conversation state now:",
    request.checkpoint.trim(),
  ];
  if (request.keep?.trim()) lines.push("", "Keep active:", request.keep.trim());
  if (request.drop?.trim()) lines.push("", "Dropped from active context:", request.drop.trim());
  return lines.join("\n");
}

function formatSettleSummary(request: SettleRequest): string {
  const lines = [
    "Prior conversation was settled into IdeaSpaces state and removed from active context.",
    "",
    `Conversation: ${request.conversation.name ?? "(unnamed)"}`,
    `Conversation-Id: ${request.conversation.id}`,
    "",
    "Captured durable state:",
    formatCaptureRefs(request.captures),
    "",
    "Checkpoint:",
    request.checkpoint.trim(),
  ];
  if (request.keep?.trim()) lines.push("", "Still active:", request.keep.trim());
  if (request.drop?.trim()) lines.push("", "Intentionally omitted from active context:", request.drop.trim());
  lines.push("", "The raw process remains in the local Pi JSONL session tree and can be revisited via /tree or future recall tooling.");
  return lines.join("\n");
}

function settleRequestFromDetails(details: unknown): SettleRequest | null {
  if (!Check(SettleDetailsSchema, details)) return null;
  return (details as SettleDetails).request;
}

function isSettleToolResultEntry(entry: SessionEntry, requestId?: string): entry is SettleToolResultEntry {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
  if (entry.message.toolName !== "is_settle") return false;
  const request = settleRequestFromDetails(entry.message.details);
  if (!request) return false;
  return requestId ? request.id === requestId : true;
}

function assistantEntryForToolCall(entries: SessionEntry[], toolCallId: string): SessionMessageEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type === "toolCall" && block.id === toolCallId) return entry;
    }
  }
  return null;
}

function latestSettleToolResult(entries: SessionEntry[], requestId?: string): SettleToolResultEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isSettleToolResultEntry(entry, requestId)) return entry;
  }
  return null;
}

function formatCaptureStatus(status: CaptureStatus): string {
  const lines = [
    `repo:    ${status.repoRoot}`,
    `branch:  ${status.branch ?? "(detached)"}`,
    status.ahead != null || status.behind != null
      ? `remote:  ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0}`
      : "remote:  no upstream",
    `tree:    ${status.dirty ? "dirty" : "clean"}`,
  ];

  if (status.untracked_in_tracked_dirs.length) {
    lines.push("", `untracked in tracked dirs (${status.untracked_in_tracked_dirs.length}):`, formatPathList(status.untracked_in_tracked_dirs));
  }

  if (status.tracked_captures.length) {
    lines.push("", `captures awaiting commit (${status.tracked_captures.length}):`, formatPathList(status.tracked_captures));
  } else {
    lines.push("", "no captures awaiting commit");
  }

  return lines.join("\n");
}

function formatSyncDryRun(sync: SyncDryRun): string {
  if (!sync.upstream) return "No upstream configured — nothing to sync.\n(dry run — nothing fetched or pushed)";

  const lines = [`upstream: ${sync.upstream} (ahead ${sync.ahead}, behind ${sync.behind})`];
  if (sync.behind) lines.push("would integrate remote changes (requires clean tree)");
  if (sync.ahead) lines.push(`would push ${sync.ahead} commit(s)`);
  if (!sync.ahead && !sync.behind) lines.push("up to date");
  lines.push("(dry run — nothing fetched or pushed)");
  return lines.join("\n");
}

function createArgs(name: string | undefined, shared: boolean, apply: boolean): string[] {
  const args = ["create"];
  if (name) args.push(name);
  if (shared) args.push("--shared");
  if (apply) args.push("--yes");
  return args;
}

function formatCreatePlan(plan: CreatePlan): string {
  const lines = [
    `target:  ${plan.target}`,
    `shape:   ${plan.shape}${plan.privateAgent ? " (private _agent/)" : ""}`,
    "",
    "plan:",
  ];

  for (const step of plan.plan) {
    const op = step.op.toUpperCase().padEnd(9);
    const path = step.path ? ` ${step.path}` : "";
    const detail = step.detail ? ` — ${step.detail}` : "";
    lines.push(`  ${op}${path}${detail}`);
  }

  return lines.join("\n");
}

function buildStatusLine(root: string | null, status: CaptureStatus | null): string {
  const name = root ? basename(root) : "local-first";
  const parts = [`📚 ${name}`];
  if (!status) return parts.join(" · ");

  if (status.tracked_captures.length) parts.push(`${status.tracked_captures.length} captures`);
  if (status.dirty) parts.push("dirty");
  if (status.ahead != null && status.behind != null && (status.ahead || status.behind)) {
    parts.push(`↑${status.ahead} ↓${status.behind}`);
  }
  return parts.join(" · ");
}

function buildCaptureWidget(status: CaptureStatus): string[] | undefined {
  if (!status.tracked_captures.length) return undefined;

  return [
    `Captures awaiting save (${status.tracked_captures.length}):`,
    ...formatPathList(status.tracked_captures, 5).split("\n"),
    "/is-commit to save · /is-sync to push",
  ];
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolvePath(parent), resolvePath(child));
  // `rel === ""` handles the degenerate equality case; callers pass files,
  // but keeping the helper complete makes boundary assertions easier to read.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function toolPath(input: Record<string, unknown>): string | null {
  // Pi built-in write/edit inputs use `path`.
  const path = input.path;
  if (typeof path !== "string" || !path.trim()) return null;
  // Pi's at-mention syntax prefixes paths with @; strip it before resolving.
  return path.trim().replace(/^@/, "");
}

function isKnowledgePath(path: string): boolean {
  const normalized = resolvePath(path);
  const parts = normalized.split(sep);
  return normalized.endsWith(".md") || parts.includes("_agent");
}

async function gitRootForDir(
  pi: ExtensionAPI,
  cache: Map<string, string | null>,
  dir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = resolvePath(dir);
  // Session-scoped cache: git ownership is stable for normal Pi sessions. If a
  // user runs `git init` mid-session, a reload/new session refreshes this map.
  if (cache.has(key)) return cache.get(key) ?? null;

  const result = await pi.exec("git", ["-C", key, "rev-parse", "--show-toplevel"], { signal, timeout: 5_000 });
  const root = result.code === 0 && result.stdout.trim() ? resolvePath(result.stdout.trim()) : null;
  cache.set(key, root);
  return root;
}

async function shouldNudgeKnowledgeWrite(
  pi: ExtensionAPI,
  cwd: string,
  rawPath: string,
  gitRootCache: Map<string, string | null>,
  signal?: AbortSignal,
): Promise<{ path: string; spaceRoot: string } | null> {
  const absPath = resolvePath(cwd, rawPath);
  if (!isKnowledgePath(absPath)) return null;

  const space = await findSpaceRoot(dirname(absPath));
  if (space.source === "none" || !space.root) return null;

  const spaceRoot = resolvePath(space.root);
  if (!isPathInside(absPath, spaceRoot)) return null;

  // Avoid noisy nudges for markdown/docs inside nested code repos contained by
  // a parent ideaspace. If the nested repo is its own ideaspace, findSpaceRoot
  // returns that nested root and the repo root matches, so nudges still apply.
  const gitRoot = await gitRootForDir(pi, gitRootCache, dirname(absPath), signal);
  if (gitRoot && gitRoot !== spaceRoot && isPathInside(absPath, gitRoot)) return null;

  return { path: absPath, spaceRoot };
}

function formatPositionSection(cwd: string, repoRoot: string, pathContext: Awaited<ReturnType<typeof walkPathContext>>): string {
  const spaceRoot = spaceRootLevel(pathContext);
  const branch = currentBranchLevel(pathContext);
  const cwdRel = relative(repoRoot, cwd) || ".";
  const lines = ["Position:"];
  lines.push(`  repo: ${repoRoot}`);
  lines.push(`  cwd: ${cwdRel}`);
  if (spaceRoot) lines.push(`  space root: ${spaceRoot.path || "."}`);
  if (branch) lines.push(`  active _agent: ${branch.path || "."}`);
  return lines.join("\n");
}

function formatStateSection(status: CaptureStatus | null): string | null {
  if (!status) return null;
  const lines = ["State:"];
  lines.push(`  branch: ${status.branch ?? "(detached)"}`);
  if (status.ahead != null || status.behind != null) {
    lines.push(`  remote: ahead ${status.ahead ?? 0}, behind ${status.behind ?? 0}`);
  } else {
    lines.push("  remote: no upstream");
  }
  lines.push(`  working tree: ${status.dirty ? "dirty" : "clean"}`);
  lines.push(`  captures awaiting commit: ${status.tracked_captures.length}`);
  if (status.untracked_in_tracked_dirs.length) {
    lines.push(`  untracked knowledge files: ${status.untracked_in_tracked_dirs.length}`);
  }
  return lines.join("\n");
}

async function readCaptureStatus(cwd: string): Promise<CaptureStatus | null> {
  const result = await runJson<CaptureStatus>(["status"], cwd);
  return result.ok ? result.data : null;
}

async function buildAwareness(cwd: string): Promise<{ root: string | null; repoRoot: string | null; text: string | null }> {
  const space = await findSpaceRoot(cwd);
  if (space.source === "none" || !space.root) return { root: null, repoRoot: null, text: null };

  const status = await readCaptureStatus(cwd);
  let repoRoot = status?.repoRoot ?? null;
  if (!repoRoot) {
    try {
      repoRoot = (await gitState(cwd)).repoRoot;
    } catch {
      // No git repo available. Do not substitute the ideaspace root here:
      // space root and git root are different concepts.
      repoRoot = null;
    }
  }

  let lastSha: string | undefined;
  if (repoRoot) {
    // First run (no marker yet) returns undefined — no "since last session" diff.
    lastSha = readSeenMarker(repoRoot);
  }
  const [block, pathContext] = await Promise.all([
    assembleAwareness({
      root: space.root,
      contract: space.contract,
      lastSha,
    }),
    repoRoot ? walkPathContext(repoRoot, cwd) : Promise.resolve(null),
  ]);
  const drift: string[] = [];
  if (!space.contract.purpose) {
    drift.push(
      "⚠ `_agent/purpose.md` not yet captured. The contract names it; suggest capturing in conversation when there's a natural moment.",
    );
  }
  if (!space.contract.now) {
    drift.push(
      "⚠ `_agent/now.md` not yet captured. Suggest capturing what's currently active.",
    );
  }

  const parts = [
    pathContext && repoRoot ? formatPositionSection(cwd, repoRoot, pathContext) : null,
    formatStateSection(status),
    block.trim(),
    ...drift,
  ].filter(Boolean);
  return { root: space.root, repoRoot, text: parts.length ? parts.join("\n\n") : null };
}

export default function (pi: ExtensionAPI) {
  let cachedAwareness: string | null = null;
  let cachedRoot: string | null = null;
  let cachedRepoRoot: string | null = null;
  const fdCommand = resolveFdCommand();
  const gitRootCache = new Map<string, string | null>();
  let autocompleteFailureShown = false;
  let recentCaptures: CaptureRef[] = [];
  let pendingSettle: SettleRequest | null = null;
  let settleCompactTimer: ReturnType<typeof setTimeout> | undefined;

  async function refreshAwareness(cwd: string): Promise<void> {
    try {
      const awareness = await buildAwareness(cwd);
      cachedAwareness = awareness.text;
      cachedRoot = awareness.root;
      cachedRepoRoot = awareness.repoRoot;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`IdeaSpaces: awareness build failed: ${message}`);
      cachedAwareness = null;
      cachedRoot = null;
      cachedRepoRoot = null;
    }
  }

  function updateSpaceUi(ctx: ExtensionContext, status: CaptureStatus | null): void {
    ctx.ui.setStatus("is", buildStatusLine(cachedRoot, status));
    ctx.ui.setWidget("is-captures", status ? buildCaptureWidget(status) : undefined, { placement: "belowEditor" });
  }

  async function refreshSpaceUi(ctx: ExtensionContext, cwd = ctx.cwd): Promise<CaptureStatus | null> {
    if (!cachedRoot) {
      updateSpaceUi(ctx, null);
      return null;
    }

    const status = await readCaptureStatus(cwd);
    updateSpaceUi(ctx, status);
    return status;
  }

  async function readConversation(ctx: ExtensionContext): Promise<ConversationMeta> {
    return readCurrentConversation(ctx, { spaceRoot: cachedRoot });
  }

  async function upsertConversation(
    ctx: ExtensionContext,
    update: { name?: string; description?: string; settledAt?: string } = {},
  ): Promise<ConversationMeta> {
    return upsertCurrentConversation(ctx, { ...update, spaceRoot: cachedRoot });
  }

  function recordCapture(capture: CaptureRef): void {
    recentCaptures = dedupeCaptures([capture, ...recentCaptures]).slice(0, 20);
  }

  async function commitTrackedCaptures(ctx: ExtensionContext, status: CaptureStatus): Promise<boolean> {
    // `/is-commit` can call this with no tracked paths; session guards only
    // call it after detecting pending captures.
    if (!status.tracked_captures.length) {
      ctx.ui.notify("No IdeaSpaces captures awaiting commit", "info");
      return true;
    }

    if (!ctx.hasUI) {
      console.warn(
        `IdeaSpaces: commit cancelled — ${status.tracked_captures.length} capture(s) awaiting commit, but UI is unavailable.`,
      );
      return false;
    }

    const paths = formatPathList(status.tracked_captures);
    const defaultMessage = status.tracked_captures.length === 1
      ? `Capture ${basename(status.tracked_captures[0])}`
      : "Capture IdeaSpaces notes";
    const message = await ctx.ui.editor("Commit message", defaultMessage);
    const trimmed = message?.trim();
    if (!trimmed) {
      ctx.ui.notify("Commit cancelled — no message", "info");
      return false;
    }

    const confirmed = await ctx.ui.confirm(
      "Commit staged captures?",
      `This commits the staged IdeaSpaces knowledge:\n\n${paths}\n\nMessage: ${trimmed}`,
    );
    if (!confirmed) {
      ctx.ui.notify("Commit cancelled", "info");
      return false;
    }

    const result = await runJson<{ commit_sha: string; committed_paths: string[] }>(["commit", "-m", trimmed, "--all"], ctx.cwd);
    if (!result.ok) {
      ctx.ui.notify(`Commit failed:\n${result.error}`, "error");
      await refreshSpaceUi(ctx);
      return false;
    }

    await refreshAwareness(ctx.cwd);
    await refreshSpaceUi(ctx);
    ctx.ui.notify(`Committed ${result.data.committed_paths.length} path(s): ${result.data.commit_sha}`, "info");
    return true;
  }

  async function guardPendingCaptures(ctx: ExtensionContext, action: string): Promise<{ cancel: true } | undefined> {
    await refreshAwareness(ctx.cwd);
    const status = await refreshSpaceUi(ctx);
    if (!status?.tracked_captures.length) return undefined;

    if (!ctx.hasUI) {
      console.warn(
        `IdeaSpaces: ${action} cancelled — ${status.tracked_captures.length} capture(s) awaiting commit (non-interactive mode).`,
      );
      return { cancel: true };
    }

    const choice = await ctx.ui.select(
      `You have ${status.tracked_captures.length} IdeaSpaces capture(s) awaiting commit before ${action}.`,
      ["Save now", "Proceed without saving", "Cancel"],
    );

    if (choice === "Proceed without saving") return undefined;
    if (choice === "Save now") {
      const committed = await commitTrackedCaptures(ctx, status);
      return committed ? undefined : { cancel: true };
    }

    ctx.ui.notify(`${action} cancelled — captures are still awaiting commit`, "warning");
    return { cancel: true };
  }

  function guardPendingSettle(ctx: ExtensionContext, action: string): { cancel: true } | undefined {
    if (!pendingSettle) return undefined;
    const message = `IdeaSpaces: ${action} cancelled — context settle is still pending. Wait for compaction to finish or run /is-settle cancel.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
    return { cancel: true };
  }

  pi.on("session_start", async (_event, ctx) => {
    recentCaptures = [];
    pendingSettle = null;
    await refreshAwareness(ctx.cwd);
    await refreshSpaceUi(ctx);

    // IdeaSpaces often uses .gitignore as a sharing boundary, not a local
    // context boundary. Broaden @mention discovery to include gitignored local
    // files while still excluding dependency and git metadata noise.
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const mention = extractAtMention(textBeforeCursor);
        if (!mention) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        if (!fdCommand) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const suggestions = await collectFileSuggestions(pi, fdCommand, ctx.cwd, mention.query, options.signal);
        if (!suggestions) {
          if (!autocompleteFailureShown) {
            autocompleteFailureShown = true;
            ctx.ui.notify("IdeaSpaces @mention expansion failed; check fd availability", "warning");
          }
          return null;
        }
        if (suggestions.length === 0) return null;

        return {
          prefix: mention.prefix,
          items: suggestions.map((suggestion) => ({
            value: formatAutocompleteValue(suggestion.path, suggestion.isDirectory, mention.quoted),
            label: `${basename(suggestion.path)}${suggestion.isDirectory ? "/" : ""}`,
            description: suggestion.path,
          })),
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, _prefix) {
        const currentLine = lines[cursorLine] ?? "";
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const mention = extractAtMention(textBeforeCursor);
        if (!mention) return current.applyCompletion(lines, cursorLine, cursorCol, item, _prefix);

        const beforeMention = currentLine.slice(0, cursorCol - mention.prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const isDirectory = item.label.endsWith("/");
        const suffix = isDirectory ? "" : " ";
        const hasTrailingQuote = item.value.endsWith('"');
        const adjustedAfterCursor = mention.quoted && hasTrailingQuote && afterCursor.startsWith('"')
          ? afterCursor.slice(1)
          : afterCursor;
        const nextLine = `${beforeMention}${item.value}${suffix}${adjustedAfterCursor}`;
        const nextLines = [...lines];
        nextLines[cursorLine] = nextLine;

        const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
        return {
          lines: nextLines,
          cursorLine,
          cursorCol: beforeMention.length + cursorOffset + suffix.length,
        };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await refreshAwareness(ctx.cwd);
    if (!cachedAwareness) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n[IdeaSpaces Awareness]\n${cachedAwareness}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const rawPath = toolPath(event.input);
    if (!rawPath) return undefined;

    try {
      const nudge = await shouldNudgeKnowledgeWrite(pi, ctx.cwd, rawPath, gitRootCache, ctx.signal);
      if (!nudge) return undefined;

      const displayPath = relative(nudge.spaceRoot, nudge.path) || rawPath;
      return {
        content: [
          ...(event.content ?? []),
          {
            type: "text" as const,
            text:
              `IdeaSpaces note: \`${displayPath}\` is a knowledge file changed with native ${event.toolName}. ` +
              "If this represents durable shared understanding, use the capture flow (`is-capture` / `/is-commit`) so it is staged, tracked, and committed deliberately.",
          },
        ],
      };
    } catch {
      // Capture nudges are best-effort; never break the original tool result.
      return undefined;
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const action = event.reason === "new" ? "starting a new session" : "switching sessions";
    return guardPendingSettle(ctx, action) ?? guardPendingCaptures(ctx, action);
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    return guardPendingSettle(ctx, "forking this session") ?? guardPendingCaptures(ctx, "forking this session");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const request = pendingSettle;
    if (!request) return;
    // Defer until Pi finishes draining agent_end handlers; compacting synchronously here can re-enter the session lifecycle.
    settleCompactTimer = setTimeout(() => {
      settleCompactTimer = undefined;
      if (pendingSettle?.id !== request.id) return;
      let idle: boolean;
      try {
        idle = ctx.isIdle();
      } catch {
        pendingSettle = null;
        return;
      }
      if (!idle) {
        pendingSettle = null;
        ctx.ui.notify("Context settle cancelled — session was not idle after agent end. Run is_settle again if needed.", "warning");
        return;
      }
      try {
        ctx.compact({
          customInstructions: "Settle IdeaSpaces conversation context after capture.",
          onComplete: () => {
            pendingSettle = null;
            ctx.ui.notify("Settled active context", "info");
          },
          onError: (error) => {
            pendingSettle = null;
            ctx.ui.notify(`Context settle compaction failed: ${error.message}`, "warning");
            try {
              pi.sendMessage({
                customType: "is-settle-status",
                content: `[IdeaSpaces settle failed]\n${error.message}`,
                display: true,
                details: { kind: "is-settle-error", requestId: request.id },
              });
            } catch {
              // Best-effort: the session may already be shutting down.
            }
          },
        });
      } catch (error) {
        pendingSettle = null;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Context settle could not start: ${message}`, "warning");
      }
    }, 0);
  });

  pi.on("session_before_compact", async (event) => {
    const request = pendingSettle;
    if (!request) return undefined;

    const settleEntry = latestSettleToolResult(event.branchEntries, request.id);
    if (!settleEntry) return undefined;

    const firstKeptEntry = assistantEntryForToolCall(event.branchEntries, settleEntry.message.toolCallId) ?? settleEntry;
    return {
      compaction: {
        summary: formatSettleSummary(request),
        firstKeptEntryId: firstKeptEntry.id,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          kind: "is-settle",
          conversationId: request.conversation.id,
          checkpointEntryId: settleEntry.id,
          firstKeptEntryId: firstKeptEntry.id,
          captures: request.captures,
        },
      },
    };
  });

  pi.on("session_compact", async (event, ctx) => {
    const details = event.compactionEntry.details;
    if (isRecord(details) && details.kind === "is-settle") {
      await upsertConversation(ctx, { settledAt: event.compactionEntry.timestamp });
      pendingSettle = null;
      recentCaptures = [];
    }
  });

  pi.on("session_shutdown", async () => {
    pendingSettle = null;
    if (settleCompactTimer) {
      clearTimeout(settleCompactTimer);
      settleCompactTimer = undefined;
    }
    // Lifecycle write, not awareness assembly: persist the last-seen commit so
    // the next session can render "Since last session" from git history.
    if (!cachedRepoRoot) return;
    try {
      const state = await gitState(cachedRepoRoot);
      if (state.headSha) setSeenMarker(cachedRepoRoot, state.headSha);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`IdeaSpaces: failed to persist last-seen HEAD: ${message}`);
    }
  });

  pi.registerCommand("is-setup", {
    description: "Scaffold an ideaspace with a guided preview and confirmation",
    handler: async (args, ctx) => {
      const targetName = args.trim() || undefined;
      let shared = false;
      let preview = await runJson<CreatePlan>(createArgs(targetName, shared, false), ctx.cwd);
      if (!preview.ok) {
        const level = preview.error.includes("already an ideaspace") ? "info" : "error";
        ctx.ui.notify(`Create preview failed:\n${preview.error}`, level);
        return;
      }

      if (preview.data.shape === "code-repo") {
        const choice = await ctx.ui.select(
          "This looks like a code repo. How should IdeaSpaces scaffold agent context?",
          [
            "Private _agent/ (default for code repos)",
            "Shared committed _agent/",
            "Cancel",
          ],
        );
        if (choice === "Cancel" || choice === undefined) {
          ctx.ui.notify("Setup cancelled", "info");
          return;
        }
        shared = choice === "Shared committed _agent/";
        if (shared) {
          preview = await runJson<CreatePlan>(createArgs(targetName, shared, false), ctx.cwd);
          if (!preview.ok) {
            ctx.ui.notify(`Create preview failed:\n${preview.error}`, "error");
            return;
          }
        }
      }

      const confirmed = await ctx.ui.confirm(
        "Create ideaspace scaffold?",
        `${formatCreatePlan(preview.data)}\n\nThe CLI is the source of truth and will not overwrite existing markdown or CLAUDE.md. Apply this plan?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Setup cancelled", "info");
        return;
      }

      const result = await runJson<CreateResult>(createArgs(targetName, shared, true), ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(`Setup failed:\n${result.error}\n\nUse git status / git restore to recover any partial scaffold.`, "error");
        return;
      }

      if (!targetName) {
        await refreshAwareness(ctx.cwd);
        await refreshSpaceUi(ctx);
      }

      const next = targetName
        ? `Open ${result.data.target} in Pi to continue. Run /is-publish there when ready to host it remotely.`
        : "Next session will start oriented to this space. Run /is-publish when ready to host it remotely.";
      ctx.ui.notify(`Scaffolded ideaspace at ${result.data.target}.\n${next}`, "info");
    },
  });

  pi.registerCommand("is-publish", {
    description: "Publish this ideaspace to the IdeaSpaces remote after guided preflight",
    handler: async (_args, ctx) => {
      const space = await findSpaceRoot(ctx.cwd);
      if (space.source === "none" || !space.root) {
        ctx.ui.notify("Run /is-publish from the root of a scaffolded ideaspace. Use /is-setup first if this folder has no _agent/ contract.", "warning");
        return;
      }
      if (resolvePath(space.root) !== resolvePath(ctx.cwd)) {
        ctx.ui.notify(`Run /is-publish from the ideaspace root: ${space.root}`, "warning");
        return;
      }

      await refreshAwareness(ctx.cwd);
      const status = await refreshSpaceUi(ctx);
      if (status?.tracked_captures.length) {
        const choice = await ctx.ui.select(
          `You have ${status.tracked_captures.length} IdeaSpaces capture(s) awaiting commit before publish.`,
          ["Save first", "Publish committed state only", "Cancel"],
        );
        if (choice === "Cancel" || choice === undefined) {
          ctx.ui.notify("Publish cancelled — captures are still awaiting commit", "info");
          return;
        }
        if (choice === "Save first") {
          const committed = await commitTrackedCaptures(ctx, status);
          if (!committed) return;
        }
      }

      const folderName = basename(ctx.cwd);
      const publishArgs = ["publish"];
      let summary = "Using folder defaults. If this folder is already published, the CLI will reuse its existing remote mapping.";

      const choice = await ctx.ui.select("Publish destination", ["Use folder defaults", "Customize first publish", "Cancel"]);
      if (choice === "Cancel" || choice === undefined) {
        ctx.ui.notify("Publish cancelled", "info");
        return;
      }
      if (choice === "Customize first publish") {
        const displayNameInput = await ctx.ui.input("Display name", folderName);
        if (displayNameInput === undefined) {
          ctx.ui.notify("Publish cancelled", "info");
          return;
        }
        const slugInput = await ctx.ui.input("Slug (CLI will normalize)", folderName);
        if (slugInput === undefined) {
          ctx.ui.notify("Publish cancelled", "info");
          return;
        }
        const hostnameInput = await ctx.ui.input("Organization hostname (blank for personal)", "");
        if (hostnameInput === undefined) {
          ctx.ui.notify("Publish cancelled", "info");
          return;
        }

        const displayName = displayNameInput.trim() || folderName;
        const slug = slugInput.trim() || folderName;
        const hostname = hostnameInput.trim();
        publishArgs.push("--name", displayName, "--slug", slug);
        if (hostname) publishArgs.push("--hostname", hostname);
        summary = [
          `name:      ${displayName}`,
          `slug:      ${slug} (CLI normalizes before creating the remote)`,
          `namespace: ${hostname || "your personal namespace"}`,
          "",
          "If this folder is already published, the CLI will refuse these first-publish flags instead of silently ignoring them.",
        ].join("\n");
      }

      const confirmed = await ctx.ui.confirm(
        "Publish ideaspace?",
        `${summary}\n\nPublishing sets this repo's local git identity to your IdeaSpaces identity. On first publish, the CLI may amend the tip commit author so server attribution passes; review git history afterward if that matters. Continue?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Publish cancelled", "info");
        return;
      }

      let published = await runJson<PublishResult>(publishArgs, ctx.cwd);
      if (!published.ok && published.error.includes("Not logged in")) {
        const login = await ctx.ui.confirm(
          "Log in to IdeaSpaces?",
          "Publishing requires IdeaSpaces credentials. I'll open the browser login flow and save credentials locally, then retry publish. Continue?",
        );
        if (!login) {
          ctx.ui.notify("Publish cancelled — login required", "info");
          return;
        }
        const loginResult = await run(["login"], undefined, ctx.cwd);
        if (isErrorResult(loginResult)) {
          ctx.ui.notify(`Login failed:\n${loginResult.content.map((c) => c.text).join("\n")}`, "error");
          return;
        }
        published = await runJson<PublishResult>(publishArgs, ctx.cwd);
      }
      if (!published.ok) {
        const hint = published.error.includes("Local branch is")
          ? "\n\nRename the current branch with `git branch -m main` and re-run /is-publish."
          : "";
        ctx.ui.notify(`Publish failed:\n${published.error}${hint}`, "error");
        return;
      }

      await refreshAwareness(ctx.cwd);
      await refreshSpaceUi(ctx);
      ctx.ui.notify(
        `Published ${published.data.namespace}/${published.data.slug}.\nView: ${published.data.web_url}\nGit remote: ${published.data.remote_url}\nLocal identity: ${published.data.identity_email}`,
        "info",
      );
    },
  });

  pi.registerCommand("is-conversation", {
    description: "Show or update the current IdeaSpaces conversation flow name/description",
    handler: async (args, ctx) => {
      await refreshAwareness(ctx.cwd);
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status" || trimmed === "show") {
        ctx.ui.notify(formatConversationMeta(await readConversation(ctx)), "info");
        return;
      }

      if (trimmed === "name" || trimmed.startsWith("name ")) {
        const provided = trimmed === "name" ? undefined : trimmed.slice("name ".length).trim();
        const name = provided || (await ctx.ui.input("Conversation name", ctx.sessionManager.getSessionName() ?? ""));
        const nextName = name?.trim();
        if (!nextName) {
          ctx.ui.notify("Conversation name unchanged", "info");
          return;
        }
        pi.setSessionName(nextName);
        ctx.ui.notify(formatConversationMeta(await upsertConversation(ctx, { name: nextName })), "info");
        return;
      }

      if (trimmed === "describe" || trimmed.startsWith("describe ")) {
        const current = await readConversation(ctx);
        const provided = trimmed === "describe" ? undefined : trimmed.slice("describe ".length).trim();
        const description = provided || (await ctx.ui.editor("Conversation description", current.description ?? ""));
        const nextDescription = description?.trim();
        if (!nextDescription) {
          ctx.ui.notify("Conversation description unchanged", "info");
          return;
        }
        ctx.ui.notify(formatConversationMeta(await upsertConversation(ctx, { description: nextDescription })), "info");
        return;
      }

      ctx.ui.notify("Usage: /is-conversation [status|name <name>|describe <description>]", "warning");
    },
  });

  pi.registerCommand("is-settle", {
    description: "Show or cancel a pending IdeaSpaces context settle",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "cancel") {
        if (!pendingSettle) {
          ctx.ui.notify("No context settle is pending", "info");
          return;
        }
        pendingSettle = null;
        if (settleCompactTimer) {
          clearTimeout(settleCompactTimer);
          settleCompactTimer = undefined;
        }
        ctx.ui.notify("Cancelled pending context settle", "info");
        return;
      }
      if (action === "status" || action === "show") {
        if (!pendingSettle) {
          ctx.ui.notify("No context settle is pending", "info");
          return;
        }
        ctx.ui.notify(formatSettleCheckpoint(pendingSettle), "info");
        return;
      }
      ctx.ui.notify("Usage: /is-settle [status|cancel]", "warning");
    },
  });

  pi.registerCommand("is-status", {
    description: "Show IdeaSpaces capture and sync state",
    handler: async (_args, ctx) => {
      const status = await refreshSpaceUi(ctx);
      if (!status) {
        ctx.ui.notify("No git-backed ideaspace status available here", "warning");
        return;
      }
      ctx.ui.notify(formatCaptureStatus(status), "info");
    },
  });

  pi.registerCommand("is-commit", {
    description: "Commit staged IdeaSpaces captures after confirmation",
    handler: async (_args, ctx) => {
      await refreshAwareness(ctx.cwd);
      const status = await refreshSpaceUi(ctx);
      if (!status) {
        ctx.ui.notify("No git-backed ideaspace status available here", "warning");
        return;
      }
      await commitTrackedCaptures(ctx, status);
    },
  });

  pi.registerCommand("is-sync", {
    description: "Dry-run then sync committed IdeaSpaces captures",
    handler: async (_args, ctx) => {
      await refreshAwareness(ctx.cwd);
      const status = await refreshSpaceUi(ctx);
      if (!status) {
        ctx.ui.notify("No git-backed ideaspace status available here", "warning");
        return;
      }
      if (status.tracked_captures.length) {
        ctx.ui.notify(
          `Refusing to sync: ${status.tracked_captures.length} capture(s) still await commit. Run /is-commit first.`,
          "warning",
        );
        return;
      }

      const dryRun = await runJson<SyncDryRun>(["sync", "--dry-run"], ctx.cwd);
      if (!dryRun.ok) {
        ctx.ui.notify(`Sync dry-run failed:\n${dryRun.error}`, "error");
        return;
      }

      const plan = formatSyncDryRun(dryRun.data);
      if (!dryRun.data.upstream) {
        ctx.ui.notify(plan, "info");
        return;
      }
      if (status.dirty && dryRun.data.behind) {
        ctx.ui.notify("Working tree is dirty — commit or stash changes before syncing remote updates.", "warning");
        return;
      }

      const confirmed = await ctx.ui.confirm("Run IdeaSpaces sync?", plan);
      if (!confirmed) {
        ctx.ui.notify("Sync cancelled", "info");
        return;
      }

      const result = await runJson<{ upstream: string | null; pushed: number; integrated: number }>(["sync"], ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(`Sync failed:\n${result.error}`, "error");
        await refreshSpaceUi(ctx);
        return;
      }

      await refreshAwareness(ctx.cwd);
      await refreshSpaceUi(ctx);
      ctx.ui.notify(`Synced: integrated ${result.data.integrated} commit(s), pushed ${result.data.pushed} commit(s).`, "info");
    },
  });

  pi.registerTool({
    name: "is_auth",
    label: "IS Auth",
    description:
      "Manage IdeaSpaces sync credentials. Sync is opt-in; local ideaspaces work without auth.",
    promptSnippet: "Log in or out for optional IdeaSpaces remote sync",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("login"), Type.Literal("logout")]),
      ),
    }),
    async execute(_id, params) {
      const action = params.action ?? "login";
      switch (action) {
        case "login":
          return run(["login"]);
        case "logout": {
          const result = await run(["power", "logout"]);
          if (!isErrorResult(result)) {
            cachedAwareness = null;
            cachedRoot = null;
            cachedRepoRoot = null;
          }
          return result;
        }
      }
    },
  });

  pi.registerTool({
    name: "is_write",
    label: "IS Write",
    description:
      "Capture primitive for Notes: create or update a Note with Layer 1 frontmatter (name, summary), stage it in git, and return its content sha for safe refinement. Normally use through the is-capture skill; native file tools cover code/config and ordinary edits.",
    promptSnippet: "Capture primitive: create/update a markdown Note with frontmatter; stages + returns sha",
    parameters: Type.Object({
      path: Type.String({ description: "File path within the ideaspace" }),
      content: Type.String({ description: "Markdown content; frontmatter is prepended automatically" }),
      name: Type.Optional(Type.String({ description: "Note name" })),
      summary: Type.Optional(Type.String({ description: "Dense summary for search/orientation" })),
      tags: Type.Optional(Type.Array(Type.String())),
      attached_to: Type.Optional(Type.Array(Type.String({ description: "Entity binding" }))),
      if_match: Type.Optional(
        Type.String({
          description:
            "Content sha from a prior is_write response or is_status({ path }); refuses on mismatch unless force is true.",
        }),
      ),
      force: Type.Optional(Type.Boolean({ description: "Overwrite without if_match after reconciling divergent content" })),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd;
      const args = ["write", params.path];
      if (params.name) args.push("--name", params.name);
      if (params.summary) args.push("--summary", params.summary);
      if (params.tags?.length) args.push("--tags", params.tags.join(","));
      if (params.attached_to?.length) args.push("--attached-to", params.attached_to.join(","));
      if (params.if_match) args.push("--if-match", params.if_match);
      if (params.force) args.push("--force");

      const result = await run(args, params.content, cwd);
      if (!isErrorResult(result)) {
        const text = result.content.map((item) => item.text).join("\n");
        const output = isWriteOutputFromUnknown(result.details) ?? parseIsWriteOutput(text);
        recordCapture({
          path: output?.path ?? params.path,
          name: params.name,
          summary: params.summary,
          sha: output?.sha ?? output?.commit_sha,
        });
        await refreshAwareness(cwd);
        await refreshSpaceUi(ctx, cwd);
        if (cachedRoot) await upsertConversation(ctx);
      }
      return result;
    },
  });

  pi.registerTool({
    name: "is_status",
    label: "IS Status",
    description:
      "Show IdeaSpaces capture state. Without path: returns JSON for git position plus staged captures and refreshes the UI. With path: returns single-file state text including sha for is_write if_match, without refreshing the UI.",
    promptSnippet: "Inspect IdeaSpaces capture state or get a file sha for safe updates",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Optional file path. When present, returns { exists, sha, in_index, modified, in_tracked }; use sha as is_write.if_match.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd;
      if (params.path) return run(["status", "--path", params.path], undefined, cwd);

      // A global status read is also a deliberate UI refresh; single-path sha
      // queries are local concurrency checks and should not rewrite the widget.
      await refreshAwareness(cwd);
      const result = await runJson<CaptureStatus>(["status"], cwd);
      if (!result.ok) return fail(result.error);
      updateSpaceUi(ctx, result.data);
      return ok(JSON.stringify(result.data, null, 2));
    },
  });

  pi.registerTool({
    name: "is_conversation",
    label: "IS Conversation",
    description:
      "Show or update the current local conversation flow metadata. This indexes Pi's existing JSONL session; it does not relocate or sync raw conversation logs.",
    promptSnippet: "Show/name/describe the current local conversation flow",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("name"), Type.Literal("describe")])),
      name: Type.Optional(Type.String({ description: "Conversation name when action=name" })),
      description: Type.Optional(Type.String({ description: "Conversation description when action=describe" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "status";
      if (action === "name") {
        const name = params.name?.trim();
        if (!name) return fail("is_conversation action=name requires name");
        pi.setSessionName(name);
        const meta = await upsertConversation(ctx, { name });
        return { content: [{ type: "text", text: formatConversationMeta(meta) }], details: { meta } };
      }
      if (action === "describe") {
        const description = params.description?.trim();
        if (!description) return fail("is_conversation action=describe requires description");
        const meta = await upsertConversation(ctx, { description });
        return { content: [{ type: "text", text: formatConversationMeta(meta) }], details: { meta } };
      }
      const meta = await readConversation(ctx);
      return { content: [{ type: "text", text: formatConversationMeta(meta) }], details: { meta } };
    },
  });

  pi.registerTool({
    name: "is_settle",
    label: "IS Settle",
    description:
      "Settle the current conversation state after capture: record a checkpoint and compact prior raw discussion out of active context while keeping the full JSONL session history recoverable.",
    promptSnippet: "Settle captured conversation state and slide active context to a checkpoint",
    promptGuidelines: [
      "Use is_settle only after explicit user agreement that captured raw discussion can leave active context.",
      "Use is_settle after meaningful IdeaSpaces capture when a compact checkpoint can replace verbose exploratory conversation.",
    ],
    parameters: Type.Object({
      checkpoint: Type.String({ description: "Current settled conversation state to keep as the checkpoint" }),
      keep: Type.Optional(Type.String({ description: "What should remain live in active context" })),
      drop: Type.Optional(Type.String({ description: "What raw discussion can leave active context" })),
      captures: Type.Optional(Type.Array(Type.String({ description: "Captured IdeaSpaces paths/refs represented by this checkpoint" }))),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const conversation = await upsertConversation(ctx);
      const branch = ctx.sessionManager.getBranch();
      const explicitCaptures = params.captures?.length ? captureRefsFromPaths(params.captures) : [];
      const captures = dedupeCaptures([...explicitCaptures, ...recentCaptures]);
      const request: SettleRequest = {
        id: toolCallId,
        conversation,
        checkpoint: params.checkpoint,
        keep: params.keep,
        drop: params.drop,
        captures,
        requestedAt: new Date().toISOString(),
        firstEntryId: branch[0]?.id,
        leafIdAtRequest: ctx.sessionManager.getLeafId() ?? undefined,
      };
      pendingSettle = request;

      return {
        content: [
          {
            type: "text",
            text: `${formatSettleCheckpoint(request)}\n\nContext settle scheduled: after this response finishes, prior raw conversation will be compacted out of active context. The full JSONL session remains recoverable via /tree.`,
          },
        ],
        details: { kind: "is-settle", request },
      };
    },
  });

  pi.registerTool({
    name: "is_commit",
    label: "IS Commit",
    description:
      "Capture primitive: commit agreed IdeaSpaces changes. Commits only explicit paths, or all staged IdeaSpaces knowledge when all=true; never sweeps unrelated staged user work. Confirm with the user before calling.",
    promptSnippet: "Capture primitive: commit only captured/staged IdeaSpaces paths after confirmation",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message, user-provided or user-confirmed" }),
      paths: Type.Optional(
        Type.Array(Type.String({ description: "Exact path to commit; omit only when all=true" })),
      ),
      all: Type.Optional(
        Type.Boolean({ description: "Commit all staged IdeaSpaces knowledge (markdown + _agent/) instead of explicit paths" }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["commit", "-m", params.message];
      if (params.all) args.push("--all");
      else if (params.paths?.length) args.push(...params.paths);
      const result = await run(args, undefined, params.cwd || ctx.cwd);
      if (!isErrorResult(result)) {
        await refreshAwareness(params.cwd || ctx.cwd);
        await refreshSpaceUi(ctx, params.cwd || ctx.cwd);
      }
      return result;
    },
  });

  pi.registerTool({
    name: "is_sync",
    label: "IS Sync",
    description:
      "Sync committed IdeaSpaces state: integrate remote changes and push committed captures. Refuses while staged IdeaSpaces knowledge remains uncommitted. Use through the is-sync skill when the user asks to sync/share/push.",
    promptSnippet: "Sync committed IdeaSpaces captures; dry-run before mutating when useful",
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview sync state without fetch, rebase/merge, or push" })),
      rebase: Type.Optional(Type.Boolean({ description: "Use rebase when integrating remote changes (default true)" })),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["sync"];
      if (params.dry_run) args.push("--dry-run");
      if (params.rebase === false) args.push("--rebase=false");
      const result = await run(args, undefined, params.cwd || ctx.cwd);
      if (!isErrorResult(result) && !params.dry_run) {
        await refreshAwareness(params.cwd || ctx.cwd);
        await refreshSpaceUi(ctx, params.cwd || ctx.cwd);
      }
      return result;
    },
  });
}
