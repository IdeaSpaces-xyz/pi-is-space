import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findNearestAgent,
  gitState,
  inspectMarkdownFile,
  isIdeaspacePath,
  mintChangeId,
  type MarkdownHeading,
  type MarkdownInspection,
  type MarkdownInspectionMode,
  type MarkdownInspectionRequest,
} from "@ideaspaces/protocol";
import {
  appendVolatileTail,
  buildLocalAwareness,
  discoverSpaceSkillPaths,
  LOCAL_WORKSPACE_EXCLUDES,
  readCaptureStatus,
  readMountedAwareness,
  probeTree,
  type CaptureStatus,
} from "./local-awareness.js";
import { SessionCaptureLedger } from "./capture-ledger.js";
import { localEffectCapabilities } from "./local-effects-adapter.js";
import {
  runLocalCommit,
  runLocalStatus,
  runLocalWrite,
  type LocalToolDependencies,
  type LocalToolResult,
} from "./local-tools.js";
import { parseMountEnv } from "./mounts.js";
import {
  CHANGE_ID_SHAPE,
  armingDecision,
  changeCachePath,
  clearPersistedChange,
  readPersistedChange,
  renderChangeLine,
  writePersistedChange,
  type PersistedChange,
} from "./change-state.js";
// Local shape reads and write/commit effects come directly from
// @ideaspaces/protocol. The CLI remains only the platform/transport client for
// auth, sync, publish, setup, Share, and remote catalog discovery.

type CliResult = { out: string; err: string; code: number };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type CliTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

type JsonCliResult<T> =
  | { ok: true; data: T; text: string }
  | { ok: false; error: string; text: string };

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
  root_node_id: string | null;
  identity_state: "local_only" | "unstamped_private";
};

type RootIdentityPreflight = {
  state: string;
  root_node_id: string | null;
  declaration: { dirty: boolean };
};

type CliStatusResult = {
  root_identity: RootIdentityPreflight;
};

type PublishResult = {
  repo_id: string;
  root_node_id: string | null;
  slug: string;
  namespace: string;
  remote_url: string;
  web_url: string;
  identity_email: string;
  identity_state: string;
};

// `publish` without --yes: the CLI's plan-first payload. Zero mutations have
// happened when this comes back.
type PublishPlan = {
  plan: {
    action: "publish" | "re-publish";
    namespace: string;
    slug: string;
    root_node_id: string | null;
    remote_url: string;
    identity_email: string;
    tip_author_rewrite?: boolean;
    commits: number | null;
  };
  applied: false;
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

const AUTOCOMPLETE_LIMIT = 20;
const AUTOCOMPLETE_FD_LIMIT = 1000;
const AUTOCOMPLETE_EXCLUDES = [".git", "node_modules", ...LOCAL_WORKSPACE_EXCLUDES];
const CHANGE_ID_PATTERN = CHANGE_ID_SHAPE;

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function formatInspectionHeading(heading: MarkdownHeading): string {
  return `${"#".repeat(heading.level)} ${heading.text} — line ${heading.line}, occurrence ${heading.occurrence}`;
}

function formatMarkdownInspection(path: string, inspection: MarkdownInspection): string {
  if (inspection.mode === "summary") {
    return [`Summary of ${path}:`, inspection.summary ?? "(no summary)"].join("\n\n");
  }
  if (inspection.mode === "outline") {
    const outline = inspection.headings.length
      ? inspection.headings.map(formatInspectionHeading).join("\n")
      : "(no headings)";
    return [`Outline of ${path}:`, outline].join("\n\n");
  }
  if (inspection.status === "found") {
    return [
      `Section from ${path} (${formatInspectionHeading(inspection.heading)}):`,
      inspection.markdown,
    ].join("\n\n");
  }

  const matches = inspection.matches.length
    ? `\n${inspection.matches.map((heading) => `- ${formatInspectionHeading(heading)}`).join("\n")}`
    : "";
  if (inspection.status === "ambiguous") {
    return `Section heading is ambiguous: ${inspection.query.heading}. Retry is_inspect with occurrence.${matches}`;
  }
  return `Section heading not found: ${inspection.query.heading}.${matches}`;
}

function truncateInspection(text: string, path: string): { text: string; truncation: TruncationResult } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return { text: truncation.content, truncation };

  const notice = [
    `Inspection truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `Use native read with offsets on ${path} only when exact evidence requires deeper content.`,
  ].join(" ");
  return { text: `${truncation.content}\n\n[${notice}]`, truncation };
}

function changeId(value: unknown, source: string): string {
  if (typeof value !== "string" || !CHANGE_ID_PATTERN.test(value)) {
    throw new Error(`${source} is not a valid Change-Id: ${String(value)}`);
  }
  return value;
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
// PATH command this is harmless; skills exec it directly (or via `node` for a
// `.js` bundle) — see the `is_cli` helper in the skills.
if (!process.env.IS_CLI_PATH) process.env.IS_CLI_PATH = CLI;

// Only a `.js` bundle needs `node` to run it (dev: cli/bundle/ideaspaces.js —
// and running via node doesn't depend on its executable bit). A compiled binary
// (the desktop's bundled bun sidecar — a path, but NOT `.js`) or a PATH command
// runs directly; `node <mach-o binary>` would fail. The old check keyed on "has
// a slash", which wrongly routed the bundled sidecar through node.
function cliNeedsNode(): boolean {
  return CLI.endsWith(".js");
}

// The "last seen" marker — HEAD at the end of the previous session — lives in a
// local git ref, not a file in HOME. update-ref is atomic, local refs aren't
// pushed, and `recentActivity` diffs HEAD against it for the since-last-session
// view. (Replaces the old shared session-state file.)
const SEEN_REF = "refs/ideaspaces/seen";

function setSeenMarker(cwd: string, sha: string): void {
  // Best-effort: a failed marker update must never break the session.
  spawnSync("git", ["-C", cwd, "update-ref", SEEN_REF, sha], { encoding: "utf-8" });
}

function cli(args: string[], stdin?: string, cwd?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(cliNeedsNode() ? "node" : CLI, cliNeedsNode() ? [CLI, ...args] : args, {
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

async function runText(args: string[], stdin?: string, cwd?: string): Promise<CliTextResult> {
  const { out, err, code } = await cli(["--json", ...args], stdin, cwd);
  if (code !== 0) {
    return { ok: false, error: err.trim() || out.trim() || `Exit ${code}` };
  }
  return { ok: true, text: out.trim() || err.trim() || "Done" };
}

async function runTool(args: string[], stdin?: string, cwd?: string): Promise<ToolResult> {
  const result = await runText(args, stdin, cwd);
  if (!result.ok) throw new Error(result.error);
  return ok(result.text);
}

function localToolResult(result: LocalToolResult): ToolResult {
  if (!result.ok) throw new Error(result.text);
  return ok(result.text);
}

function humanLocalToolError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      detail?: unknown;
      recovery_hint?: unknown;
    };
    if (typeof parsed.message !== "string" || !parsed.message.trim()) return text;
    return [
      parsed.message,
      ...(typeof parsed.detail === "string" && parsed.detail.trim()
        ? [`Detail: ${parsed.detail}`]
        : []),
      ...(typeof parsed.recovery_hint === "string" && parsed.recovery_hint.trim()
        ? [`Recovery: ${parsed.recovery_hint}`]
        : []),
    ].join("\n");
  } catch {
    return text;
  }
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
    "/is-commit to save · /is-push to share",
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

async function gitRootForDir(
  pi: ExtensionAPI,
  cache: Map<string, string | null>,
  dir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = resolvePath(dir);
  // Session-scoped cache: git ownership is stable for normal Pi sessions. The
  // nudge runs inside a tool-result event, so retain Pi's cancellation + timeout
  // here; protocol git reads are intentionally unbounded today.
  if (cache.has(key)) return cache.get(key) ?? null;
  const result = await pi.exec("git", ["-C", key, "rev-parse", "--show-toplevel"], {
    signal,
    timeout: 5_000,
  });
  const root = result.code === 0 && result.stdout.trim()
    ? resolvePath(result.stdout.trim())
    : null;
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
  if (!isIdeaspacePath(absPath)) return null;

  const space = await findNearestAgent(dirname(absPath));
  if (space.source === "none" || !space.root) return null;

  const spaceRoot = resolvePath(space.root);
  if (!isPathInside(absPath, spaceRoot)) return null;

  // Avoid noisy nudges for markdown/docs inside nested code repos contained by
  // a parent ideaspace. A nested repo with its own `_agent/` still nudges because
  // the nearest agent root and git root resolve to that nested repo.
  const gitRoot = await gitRootForDir(pi, gitRootCache, dirname(absPath), signal);
  if (gitRoot && gitRoot !== spaceRoot && isPathInside(absPath, gitRoot)) return null;

  return { path: absPath, spaceRoot };
}

export default function (pi: ExtensionAPI) {
  let cachedStable: string | null = null;
  let cachedVolatile: string | null = null;
  let cachedRoot: string | null = null;
  let cachedRepoRoot: string | null = null;
  // Session-persistent orientation focus. Unset → awareness roots at ctx.cwd.
  // `navigate` moves this; it never touches the session cwd or file-op paths.
  let position: string | null = null;
  // The conversation's working set beyond home: mounted roots (absolute, deduped).
  // Mounts are content, never authority — read-only reference surfaced as thin
  // handles. Mounting never changes `position`/authority, cwd, or file-op paths.
  let mounts: string[] = [];
  // Seed the working set from the host's durable set: the desktop owns the
  // conversation's mounts and passes them as `IS_MOUNTS` (comma-separated), the
  // same env channel as PI_CODING_AGENT_DIR / IS_CLI_PATH. The one-process-per-turn
  // model resets in-session `is_mount`s, so the host re-seeds each turn. `addMount`
  // resolves + dedupes; everything downstream (awareness, is_navigate) already
  // handles mounts. Skip a stale/bad entry (deleted since the host stored it,
  // or not a directory) with a warning rather than seeding a dead handle —
  // symmetric with what is_mount rejects.
  for (const raw of parseMountEnv(process.env.IS_MOUNTS)) {
    const abs = resolvePath(raw);
    try {
      if (!statSync(abs).isDirectory()) throw new Error("not a directory");
      addMount(abs);
    } catch {
      console.warn(`[is-space] skipping IS_MOUNTS entry (missing or not a directory): ${abs}`);
    }
  }
  // The remote/pullable tier of the catalog: the account's spaces not yet on
  // disk. Fetched once per session via the CLI `catalog` verb (a network call),
  // then cached; empty when logged out. Filled in the background so the first
  // turn never blocks on the network.
  let pullable: Array<{ slug: string; namespace: string }> = [];
  let pullableFetched = false;
  // The active Change — an idea-snapshot coordinate stamped as a Change-Id
  // trailer on every commit of one decision, across repos. Armed in memory here
  // and persisted to the cross-surface user-level record (change-state.ts) so a
  // pi restart doesn't silently drop it; openChangeState() is the read path.
  // Unset and nothing re-armable persisted → commits carry no Change-Id.
  let currentChangeId: string | null = null;
  // Full revision snapshots and `all` ownership live only for this loaded Pi
  // extension. A reload safely loses broad commit authority.
  const captureLedger = new SessionCaptureLedger();

  // Where the open Change persists for this session. Keyed by the session's
  // start cwd (pi's analog of CLAUDE_PROJECT_DIR) — never a per-call cwd
  // override, which affects path resolution, not identity.
  function changeCacheFile(ctx: ExtensionContext): string {
    return changeCachePath(homedir(), ctx.cwd);
  }

  // The open-Change view for this call: one read of the persisted record, then
  // armingDecision — silent re-arm ONLY for the session that opened it (pi
  // restart + resume); any other session (or the Claude surface) keeps the
  // record visible in `rec` without arming. EVERY Change-touching path goes
  // through this (is_commit, is_status, is_change_close, awareness) so the
  // arm decision is applied before any branch on armed state.
  function openChangeState(ctx: ExtensionContext): { armed: string | null; rec: PersistedChange | undefined } {
    const rec = readPersistedChange(changeCacheFile(ctx));
    if (!currentChangeId && armingDecision(rec, ctx.sessionManager.getSessionId()) === "arm") {
      currentChangeId = rec!.change_id;
    }
    return { armed: currentChangeId, rec };
  }

  // Persist the newly armed Change. Best-effort: on a write failure the Change
  // still works for this process's lifetime — it just won't survive a restart.
  function persistOpenChange(ctx: ExtensionContext, id: string, handle?: string): void {
    try {
      writePersistedChange(changeCacheFile(ctx), {
        change_id: id,
        handle,
        opened_at: Date.now(),
        session_id: ctx.sessionManager.getSessionId(),
      });
    } catch {
      // Never fail the open on a cache write; memory still carries it.
    }
  }

  function localDependencies(ctx: ExtensionContext): LocalToolDependencies {
    return {
      capabilities: localEffectCapabilities,
      ledger: captureLedger,
      sessionId: () => ctx.sessionManager.getSessionId(),
      changeId: () => openChangeState(ctx).armed ?? undefined,
      agentIdEnv: process.env.IDEASPACES_AGENT_ID,
      processCwd: ctx.cwd,
    };
  }

  const fdCommand = resolveFdCommand();
  const gitRootCache = new Map<string, string | null>();
  let autocompleteFailureShown = false;

  // The position awareness is rooted at: the navigated focus, or the cwd.
  function effectivePosition(cwd: string): string {
    return position ?? cwd;
  }

  async function setPosition(next: string | null, cwd: string): Promise<void> {
    position = next;
    await refreshAwareness(cwd);
  }

  // Add a mounted root (absolute, deduped). Returns false if already mounted.
  function addMount(root: string): boolean {
    const abs = resolvePath(root);
    if (mounts.includes(abs)) return false;
    mounts.push(abs);
    return true;
  }

  // Remove a mount matching by resolved absolute path or basename. Returns the
  // removed root, or null when nothing matched.
  function removeMount(query: string): string | null {
    const abs = resolvePath(query);
    const name = basename(query);
    const match = mounts.find((mount) => mount === abs || basename(mount) === name);
    if (!match) return null;
    mounts = mounts.filter((mount) => mount !== match);
    return match;
  }

  // Resolve a `root` arg (absolute path or basename) to a mounted root, or null.
  function resolveMount(query: string): string | null {
    const abs = resolvePath(query);
    const name = basename(query);
    return mounts.find((mount) => mount === abs || basename(mount) === name) ?? null;
  }

  // Look into a mount: compose its view at `subPath` and return it as read-only
  // content. Never changes `position`/authority — the mount's _agent/ is
  // reference, not the operating contract. Returns the view in the tool result,
  // not the persistent awareness.
  async function navigateMount(
    rootArg: string,
    rawPath: string,
    treeDepth?: number,
  ): Promise<ToolResult> {
    const mountRoot = resolveMount(rootArg);
    if (!mountRoot) {
      const available = mounts.length ? mounts.join(", ") : "(none mounted)";
      throw new Error(`No mounted root matches "${rootArg}". Mounted roots: ${available}. Use is_mount to add one.`);
    }

    const subPath = rawPath === "" || rawPath === "." ? mountRoot : resolvePath(mountRoot, rawPath);
    if (!isPathInside(subPath, mountRoot)) {
      throw new Error(`Refusing to look outside the mounted root (${mountRoot}): ${subPath}`);
    }

    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(subPath);
    } catch {
      throw new Error(`No such path in mount: ${subPath}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${subPath}`);
    }

    const awareness = await readMountedAwareness(subPath, treeDepth);
    const rel = relative(mountRoot, subPath) || ".";
    const header = [
      "Mounted content (read-only) — its `_agent/` is reference, not your operating contract.",
      `mount: ${mountRoot}`,
      `position: ${rel}`,
    ];
    if (awareness.root) header.push(`mount space root: ${awareness.root}`);
    const body = (awareness.text ?? "").trim();
    return ok([header.join("\n"), body].filter(Boolean).join("\n\n"));
  }

  // Fetch the remote/pullable tier once, best-effort and non-blocking.
  // `catalog --json` hits the network; we fire it in the background and render
  // whatever is cached, so no turn is delayed. Logged out → the call succeeds
  // with an empty tier. The latch is reset by `is_auth` (login/logout change the
  // precondition) and by a transient failure, so both can re-fetch.
  function refreshPullable(cwd: string): void {
    if (pullableFetched) return;
    pullableFetched = true; // guard against concurrent fires while in flight
    void runJson<{ entries: Array<{ slug: string; namespace: string; location: string }> }>(
      ["catalog", "--json"],
      cwd,
    )
      .then((result) => {
        if (result.ok) {
          pullable = result.data.entries
            .filter((entry) => entry.location === "online-only")
            .map((entry) => ({ slug: entry.slug, namespace: entry.namespace }));
        } else {
          // Transient failure (e.g. server unreachable): retry next turn rather
          // than silencing the tier for the whole session.
          pullableFetched = false;
        }
      })
      .catch(() => {
        pullableFetched = false;
      });
  }

  async function refreshAwareness(cwd: string): Promise<void> {
    refreshPullable(cwd);
    try {
      const awareness = await buildLocalAwareness({
        position: effectivePosition(cwd),
        mounts,
        workspace: cwd,
        pullable,
      });
      cachedStable = awareness.stable;
      cachedVolatile = awareness.volatile;
      cachedRoot = awareness.root;
      cachedRepoRoot = awareness.repoRoot;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`IdeaSpaces: awareness build failed: ${message}`);
      cachedStable = null;
      cachedVolatile = null;
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
    // One gate, not three: the person invoked the command (or chose "Save
    // now"), and the message editor shows exactly what will be committed.
    // Accepting the message is the agreement; a further "are you sure?" is the
    // settle-tier double-charge users reported (agreement-tiers).
    ctx.ui.notify(`Committing the staged IdeaSpaces knowledge:\n\n${paths}`, "info");
    const defaultMessage = status.tracked_captures.length === 1
      ? `Capture ${basename(status.tracked_captures[0])}`
      : "Capture IdeaSpaces notes";
    const message = await ctx.ui.editor("Commit message (empty cancels)", defaultMessage);
    const trimmed = message?.trim();
    if (!trimmed) {
      ctx.ui.notify("Commit cancelled — no message", "info");
      return false;
    }

    // The person just reviewed this exact list. Pass canonical absolute paths
    // to the same in-process adapter as the tool rather than broadening to `all`.
    const reviewedRoot = await localEffectCapabilities.filesystem.realpath(status.repoRoot);
    const result = await runLocalCommit(
      {
        message: trimmed,
        paths: status.tracked_captures.map((path) => join(reviewedRoot, ...path.split("/"))),
        cwd: reviewedRoot,
      },
      localDependencies(ctx),
    );
    if (!result.ok) {
      ctx.ui.notify(`Commit failed:\n${humanLocalToolError(result.text)}`, "error");
      await refreshSpaceUi(ctx);
      return false;
    }

    const committed = JSON.parse(result.text) as {
      commit_sha: string;
      committed_paths: string[];
    };
    await refreshAwareness(ctx.cwd);
    await refreshSpaceUi(ctx);
    ctx.ui.notify(`Committed ${committed.committed_paths.length} path(s): ${committed.commit_sha}`, "info");
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

  // Native skill acquisition (the SKILLS-2 placement model): the home space
  // root's `_agent/skills/` entries register as Pi skills — listed by name and
  // description in <available_skills>, bodies loaded via read. Branch skills
  // stay awareness-discovered as focus moves. Fires at startup and on every
  // /new, /resume, /fork, and reload; derived from disk each time because
  // reload discards module state.
  pi.on("resources_discover", async (event) => {
    const skillPaths = await discoverSpaceSkillPaths(event.cwd);
    return skillPaths.length ? { skillPaths } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshAwareness(ctx.cwd);
    await refreshSpaceUi(ctx);

    // A cross-session (or cross-surface) open Change deserves more than buried
    // context: notify once at session start so the resume-or-close decision is
    // visible. Same-session records re-arm silently in openChangeState and
    // need no warning.
    const { armed, rec } = openChangeState(ctx);
    if (!armed && rec) {
      ctx.ui.notify(
        `Change open from a previous session: ${rec.change_id} — resume with is_change_open or clear with is_change_close`,
        "warning",
      );
    }

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

  // The open-Change line is session state, computed fresh at render time
  // (never cached with awareness) and rendered even when no `_agent/` contract
  // resolves here — a Change spans repos and surfaces. Display-only; arming
  // stays in openChangeState.
  function openChangeLine(ctx: ExtensionContext): string | undefined {
    const { armed, rec } = openChangeState(ctx);
    // Render from the record only when it verifiably describes the armed
    // Change (a failed persist can leave a stale record for a different id).
    return armed
      ? rec && rec.change_id === armed
        ? renderChangeLine(rec, ctx.sessionManager.getSessionId(), Date.now())
        : `Change open: ${armed} (this session) — stamping every is_commit; close with is_change_close when the decision lands.`
      : rec
        ? renderChangeLine(rec, ctx.sessionManager.getSessionId(), Date.now())
        : undefined;
  }

  // Cache placement (design + measurement: pi-cache-placement in the team
  // roadmap space — a separate private repo, not a path in this one): only the
  // STABLE register enters the system prompt. Its bytes are deterministic for
  // unchanged state, so an unchanged session keeps its prompt-cache prefix; a
  // landed capture or a deliberate navigate changes the bytes — a legitimate,
  // automatic invalidation, never per-turn churn.
  pi.on("before_agent_start", async (event, ctx) => {
    await refreshAwareness(ctx.cwd);
    if (!cachedStable) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n[IdeaSpaces Awareness]\n${cachedStable}`,
    };
  });

  // The VOLATILE register (State, activity, catalog, drift, Change line) is
  // appended per LLM call, strictly AFTER the last cache breakpoint. Transient
  // content anywhere inside the cached prefix would poison every later lookup
  // — and the `context` event cannot control breakpoint placement (pi puts it
  // on the last user message, which a transient tail would become). Here the
  // payload is already built: the breakpoint sits on the real last user
  // message, and this block lands after it, outside every cached prefix.
  let warnedTailShape = false;
  pi.on("before_provider_request", async (event, ctx) => {
    const tail = [cachedVolatile, openChangeLine(ctx)].filter(Boolean).join("\n\n");
    if (!tail) return;
    const appended = appendVolatileTail(event.payload, `[IdeaSpaces State]\n${tail}`);
    if (!appended && !warnedTailShape) {
      // Surface the degradation once, not per call: an unrecognized payload
      // shape means git state / activity / the Change line never reach the
      // model this session — the opposite of drift surfacing honestly.
      warnedTailShape = true;
      console.warn(
        "IdeaSpaces: volatile awareness could not attach to this provider's payload shape; git state, activity, and the Change line are absent from model context this session.",
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const rawPath = toolPath(event.input);
    if (!rawPath) return undefined;

    try {
      const nudge = await shouldNudgeKnowledgeWrite(
        pi,
        ctx.cwd,
        rawPath,
        gitRootCache,
        ctx.signal,
      );
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
    return guardPendingCaptures(ctx, action);
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    return guardPendingCaptures(ctx, "forking this session");
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
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
      const space = await findNearestAgent(ctx.cwd);
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

      const identityStatus = await runJson<CliStatusResult>(["status"], ctx.cwd);
      if (!identityStatus.ok) {
        ctx.ui.notify(`Could not inspect portable Space identity:\n${identityStatus.error}`, "error");
        return;
      }
      const rootIdentity = identityStatus.data.root_identity;
      if (
        rootIdentity.declaration.dirty ||
        ["invalid", "drift", "ambiguous"].includes(rootIdentity.state)
      ) {
        ctx.ui.notify(
          `Publish refused: root identity is ${rootIdentity.declaration.dirty ? "dirty" : rootIdentity.state}. ` +
            "Commit or restore _agent/foundation.md and repair any origin/registry conflict before retrying.",
          "error",
        );
        return;
      }
      const identitySummary = rootIdentity.root_node_id
        ? `Space identity: ${rootIdentity.root_node_id} (${rootIdentity.state})`
        : `Space identity: ${rootIdentity.state} (legacy absence remains valid)`;

      const folderName = basename(ctx.cwd);
      const publishArgs = ["publish"];

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
      }

      // Plan-first: the CLI without --yes runs every preflight and returns the
      // exact plan with zero mutations. That plan — not a hand-written summary —
      // is what the person agrees to; --yes applies it (the outward tier of
      // agreement-tiers).
      let planResult = await runJson<PublishPlan>(publishArgs, ctx.cwd);
      if (!planResult.ok && planResult.error.includes("Not logged in")) {
        const login = await ctx.ui.confirm(
          "Log in to IdeaSpaces?",
          "Publishing requires IdeaSpaces credentials. I'll open the browser login flow and save credentials locally, then show you the publish plan. Continue?",
        );
        if (!login) {
          ctx.ui.notify("Publish cancelled — login required", "info");
          return;
        }
        const loginResult = await runText(["login"], undefined, ctx.cwd);
        if (!loginResult.ok) {
          ctx.ui.notify(`Login failed:\n${loginResult.error}`, "error");
          return;
        }
        planResult = await runJson<PublishPlan>(publishArgs, ctx.cwd);
      }
      if (!planResult.ok) {
        const hint = planResult.error.includes("Local branch is")
          ? "\n\nRename the current branch with `git branch -m main` and re-run /is-publish."
          : "";
        ctx.ui.notify(`Publish preflight failed:\n${planResult.error}${hint}`, "error");
        return;
      }
      const plan = planResult.data.plan;
      const commitNoun = plan.commits === 1 ? "commit" : "commits";
      const planLines = [
        identitySummary,
        plan.action === "re-publish"
          ? `Re-publish to ${plan.namespace}/${plan.slug} — existing Space identity`
          : `Create ${plan.namespace}/${plan.slug}${plan.root_node_id ? ` — adopts committed identity ${plan.root_node_id}` : ""}`,
        `Remote: ${plan.remote_url}`,
        `Local Git identity for this folder only: ${plan.identity_email}`,
        ...(plan.tip_author_rewrite ? ["The first-publish tip commit author will be rewritten to match."] : []),
        `Push: main (${plan.commits ?? "?"} ${commitNoun})`,
      ].join("\n");

      const confirmed = await ctx.ui.confirm(
        "Publish ideaspace?",
        `${planLines}\n\nNothing has happened yet — this is the CLI's plan. The Space stays private to your account until you share it. Continue?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Publish cancelled — nothing was changed", "info");
        return;
      }

      const published = await runJson<PublishResult>([...publishArgs, "--yes"], ctx.cwd);
      if (!published.ok) {
        const hint = published.error.includes("Local branch is")
          ? "\n\nRename the current branch with `git branch -m main` and re-run /is-publish."
          : "";
        ctx.ui.notify(`Publish failed:\n${published.error}${hint}`, "error");
        return;
      }
      // A plan payload must never be reported as a publish — the guard against
      // any CLI/flag mismatch reintroducing the confusion in reverse.
      if ((published.data as { applied?: boolean }).applied === false) {
        ctx.ui.notify("Publish did not apply: the CLI returned a plan where an applied result was expected. Nothing was changed.", "error");
        return;
      }

      await refreshAwareness(ctx.cwd);
      await refreshSpaceUi(ctx);
      ctx.ui.notify(
        `Published ${published.data.namespace}/${published.data.slug}.\nView: ${published.data.web_url}\nGit remote: ${published.data.remote_url}\nSpace identity: ${published.data.root_node_id ?? published.data.identity_state}\nLocal Git identity: ${published.data.identity_email}`,
        "info",
      );
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

  pi.registerCommand("is-pull", {
    description: "Dry-run then pull remote changes into the local space",
    handler: async (_args, ctx) => {
      await refreshAwareness(ctx.cwd);
      const status = await refreshSpaceUi(ctx);
      if (!status) {
        ctx.ui.notify("No git-backed ideaspace status available here", "warning");
        return;
      }

      const dryRun = await runJson<SyncDryRun>(["pull", "--dry-run"], ctx.cwd);
      if (!dryRun.ok) {
        ctx.ui.notify(`Pull dry-run failed:\n${dryRun.error}`, "error");
        return;
      }
      if (!dryRun.data.upstream) {
        ctx.ui.notify("No upstream configured — nothing to pull.", "info");
        return;
      }
      if (!dryRun.data.behind) {
        ctx.ui.notify("Already up to date — nothing to pull.", "info");
        return;
      }
      // Integrating rewrites the tree — require it committed and clean.
      if (status.tracked_captures.length) {
        ctx.ui.notify(
          `Refusing to pull: ${status.tracked_captures.length} capture(s) still await commit. Run /is-commit first.`,
          "warning",
        );
        return;
      }
      if (status.dirty) {
        ctx.ui.notify("Working tree is dirty — commit your changes before pulling remote updates.", "warning");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Pull remote changes?",
        `upstream ${dryRun.data.upstream}: behind ${dryRun.data.behind} commit(s)`,
      );
      if (!confirmed) {
        ctx.ui.notify("Pull cancelled", "info");
        return;
      }

      const result = await runJson<{ upstream: string | null; integrated: number }>(["pull"], ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(`Pull failed:\n${result.error}`, "error");
        await refreshSpaceUi(ctx);
        return;
      }

      await refreshAwareness(ctx.cwd);
      await refreshSpaceUi(ctx);
      ctx.ui.notify(`Pulled: integrated ${result.data.integrated} commit(s).`, "info");
    },
  });

  pi.registerCommand("is-push", {
    description: "Dry-run then push committed IdeaSpaces captures",
    handler: async (_args, ctx) => {
      await refreshAwareness(ctx.cwd);
      const status = await refreshSpaceUi(ctx);
      if (!status) {
        ctx.ui.notify("No git-backed ideaspace status available here", "warning");
        return;
      }
      if (status.tracked_captures.length) {
        ctx.ui.notify(
          `Refusing to push: ${status.tracked_captures.length} capture(s) still await commit. Run /is-commit first.`,
          "warning",
        );
        return;
      }

      const dryRun = await runJson<SyncDryRun>(["push", "--dry-run"], ctx.cwd);
      if (!dryRun.ok) {
        ctx.ui.notify(`Push dry-run failed:\n${dryRun.error}`, "error");
        return;
      }
      if (!dryRun.data.upstream) {
        ctx.ui.notify("No upstream configured — nothing to push.", "info");
        return;
      }
      if (dryRun.data.behind) {
        ctx.ui.notify(
          `Behind by ${dryRun.data.behind} commit(s) — run /is-pull first, then push.`,
          "warning",
        );
        return;
      }
      if (!dryRun.data.ahead) {
        ctx.ui.notify("Already up to date — nothing to push.", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Push committed captures?",
        `upstream ${dryRun.data.upstream}: ahead ${dryRun.data.ahead} commit(s)`,
      );
      if (!confirmed) {
        ctx.ui.notify("Push cancelled", "info");
        return;
      }

      const result = await runJson<{ upstream: string | null; pushed: number }>(["push"], ctx.cwd);
      if (!result.ok) {
        ctx.ui.notify(`Push failed:\n${result.error}`, "error");
        await refreshSpaceUi(ctx);
        return;
      }

      await refreshAwareness(ctx.cwd);
      await refreshSpaceUi(ctx);
      ctx.ui.notify(`Pushed ${result.data.pushed} commit(s).`, "info");
    },
  });

  pi.registerTool({
    name: "is_navigate",
    label: "IS Navigate",
    description:
      "Move your awareness focus to a position in the space — re-derives and returns the canonical summary-level Position, Now, tree, contract, and operating-skill view for that branch using the fractal-composed contract. Does not change the working directory; read/edit/bash still take explicit paths. Pass `root` with a mounted root (from is_mount) to look into that mount instead: returns its composed view at `path` as read-only content — a mount's _agent/ is reference, never your operating contract — and never changes your authority position.",
    promptSnippet: "Re-root orientation at a branch of home (orientation only; cwd unchanged), or look into a mounted root as read-only content",
    promptGuidelines: [
      "Treat the injected [IdeaSpaces Awareness] map as the first bounded orientation rung: use is_navigate only when focus or map depth must change, and do not reread represented contract or current-state files or follow their links unless the user's question requires deeper evidence.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Target position: relative to the repo root (or the mounted root when `root` is set), or absolute. \"\" or \".\" focuses the root.",
      }),
      root: Type.Optional(
        Type.String({
          description:
            "Omit or \"home\" to move your home awareness focus (authority re-roots). Pass a mounted root (absolute path or basename) to look into that mount as read-only content without changing authority.",
        }),
      ),
      depth: Type.Optional(
        Type.Number({
          description:
            "One-shot map probe: render the tree this many levels deep (soft-capped 1..4) in THIS result only — a name-rung outline below level 1, more map never content. The persistent awareness block stays at depth 1.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rootArg = params.root?.trim();
      const depth = params.depth && params.depth > 1 ? params.depth : undefined;
      if (rootArg && rootArg !== "home") {
        return navigateMount(rootArg, params.path.trim(), depth);
      }

      // Resolve against the repo root, falling back to the current awareness
      // root or cwd so navigate works before the first awareness build.
      const repoRoot = cachedRepoRoot ?? cachedRoot ?? ctx.cwd;
      const raw = params.path.trim();
      const target = raw === "" || raw === "." ? repoRoot : resolvePath(repoRoot, raw);

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(target);
      } catch {
        throw new Error(`No such path: ${target}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${target}`);
      }
      if (!isPathInside(target, repoRoot)) {
        throw new Error(`Refusing to navigate outside the repo root (${repoRoot}): ${target}`);
      }

      await setPosition(target, ctx.cwd);

      const rel = relative(repoRoot, target) || ".";
      const lines = [`Awareness focus moved to ${rel} (working directory unchanged).`];
      if (cachedRoot) lines.push(`space root: ${cachedRoot}`);
      if (cachedStable) {
        // Return the same canonical summary register immediately. The ambient
        // block will not refresh until the next agent turn, so a Now-only tool
        // result would hide the newly composed Position/tree/contract/skills.
        lines.push("", cachedStable);
      } else {
        lines.push("No _agent/ contract resolves at this position.");
      }
      if (depth) {
        // One-shot probe in this result only; the per-turn block stays depth 1.
        // Protocol tree probes add names below the summary-rung first level —
        // more map, never document content.
        const probed = await probeTree(target, depth);
        if (probed) lines.push("", "One-shot tree probe:", probed);
      }
      return ok(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "is_inspect",
    label: "IS Inspect",
    description:
      `Inspect one local Markdown file in-process at a bounded progressive-disclosure rung: summary (default), ATX outline, or one exact section. There is no full-document mode. Output is capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; use native read only when exact evidence requires deeper content.`,
    promptSnippet: "Inspect one Markdown file by summary, outline, or selected section without a full-body default",
    promptGuidelines: [
      "Use is_inspect only when the awareness/map summary leaves a material question: request an outline before a section, and a section before any native full-file read.",
      "Use Pi's native read instead of is_inspect only when exact full-document or implementation evidence is required; is_inspect has no full-document mode.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Local Markdown file: relative to the session working directory (or `cwd` when provided), or absolute. A leading @ is accepted.",
      }),
      mode: Type.Optional(
        StringEnum(["summary", "outline", "section"] as const, {
          description: "Inspection rung. Defaults to summary; full-document reads are intentionally absent.",
        }),
      ),
      heading: Type.Optional(
        Type.String({ description: "Exact, case-sensitive heading text required for section mode." }),
      ),
      occurrence: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "One-based occurrence for duplicate exact headings in section mode.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for relative path resolution. Pass this when the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const mode: MarkdownInspectionMode = params.mode ?? "summary";
      const heading = params.heading?.trim();
      if (mode !== "section" && (params.heading !== undefined || params.occurrence !== undefined)) {
        throw new Error("`heading` and `occurrence` require section mode.");
      }
      if (mode === "section" && !heading) {
        throw new Error("Section mode requires a non-empty `heading`.");
      }

      let request: MarkdownInspectionRequest;
      if (mode === "section") {
        request = params.occurrence === undefined
          ? { mode, heading: heading! }
          : { mode, heading: heading!, occurrence: params.occurrence };
      } else {
        request = { mode };
      }

      const rawPath = params.path.trim().replace(/^@/, "");
      if (!rawPath) throw new Error("Provide a Markdown file path.");
      const path = resolvePath(params.cwd || ctx.cwd, rawPath);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        throw new Error(`No such file: ${path}`);
      }
      if (!stats.isFile()) throw new Error(`Not a file: ${path}`);

      const inspection = await inspectMarkdownFile(path, request);
      signal?.throwIfAborted();
      const rendered = truncateInspection(formatMarkdownInspection(path, inspection), path);
      const { content: _boundedContent, ...truncation } = rendered.truncation;
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          path,
          mode: inspection.mode,
          ...(inspection.mode === "section" ? { status: inspection.status } : {}),
          truncation,
        },
      };
    },
  });

  pi.registerTool({
    name: "is_mount",
    label: "IS Mount",
    description:
      "Add a repo to this conversation's working set as a read-only content mount. Home stays your authority frame; a mount is reference only — its `_agent/` is never your operating contract. Surfaced as a thin handle in awareness; look inside it with is_navigate({ root }). Use when you need a second repo's context alongside home.",
    promptSnippet: "Mount another repo as read-only content in the working set (home stays authority)",
    parameters: Type.Object({
      path: Type.String({
        description: "Repo to mount: relative to the home repo root, or absolute.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const homeRoot = cachedRepoRoot ?? cachedRoot ?? ctx.cwd;
      const raw = params.path.trim();
      if (!raw) throw new Error("Provide a path to mount.");
      const target = resolvePath(homeRoot, raw);

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(target);
      } catch {
        throw new Error(`No such path: ${target}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${target}`);
      }
      if (isPathInside(target, homeRoot)) {
        throw new Error(`Already reachable from home (${homeRoot}); no mount needed: ${target}`);
      }
      if (!addMount(target)) {
        throw new Error(`Already mounted: ${target}`);
      }

      await refreshAwareness(ctx.cwd);

      // The mount's summary/handle now renders in the working set (via the
      // refreshed awareness above), so the confirmation stays terse.
      return ok(
        `Mounted (read-only): ${target}\nSurfaced as a working-set handle. Look inside with is_navigate({ root, path }). It is content, not authority.`,
      );
    },
  });

  pi.registerTool({
    name: "is_unmount",
    label: "IS Unmount",
    description:
      "Remove a repo from this conversation's working set. Matches by absolute path or basename. Home is never affected.",
    promptSnippet: "Remove a mounted repo from the working set",
    parameters: Type.Object({
      path: Type.String({
        description: "Mounted root to remove: absolute path or basename, as shown in the working set.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const raw = params.path.trim();
      if (!raw) throw new Error("Provide a mounted root to remove.");

      const removed = removeMount(raw);
      if (!removed) {
        const available = mounts.length ? mounts.join(", ") : "(none mounted)";
        throw new Error(`Not mounted: ${raw}. Mounted roots: ${available}.`);
      }

      await refreshAwareness(ctx.cwd);
      return ok(`Unmounted: ${removed}`);
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
        StringEnum(["login", "logout"] as const),
      ),
    }),
    async execute(_id, params) {
      const action = params.action ?? "login";
      switch (action) {
        case "login": {
          const result = await runTool(["login"]);
          // Now possibly logged in — re-fetch the pullable tier next turn.
          pullableFetched = false;
          return result;
        }
        case "logout": {
          const result = await runTool(["power", "logout"]);
          cachedStable = null;
          cachedVolatile = null;
          cachedRoot = null;
          cachedRepoRoot = null;
          // Drop the remote tier immediately; the next turn re-fetches (→ empty).
          pullable = [];
          pullableFetched = false;
          return result;
        }
      }
    },
  });

  pi.registerTool({
    name: "is_write",
    label: "IS Write",
    description:
      "Capture primitive for Notes: create or update a Note with Layer 1 frontmatter (name, summary), stage it in git, record its full path revision for this session, and return its content sha for safe refinement. Normally use through the is-capture skill; native file tools cover code/config and ordinary edits.",
    promptSnippet: "Capture primitive: create/update a markdown Note with frontmatter; stages + returns sha",
    parameters: Type.Object({
      path: Type.String({ description: "File path within the ideaspace" }),
      content: Type.String({ description: "Markdown content; frontmatter is prepended automatically" }),
      name: Type.Optional(Type.String({ description: "Note name" })),
      summary: Type.Optional(Type.String({ description: "Dense summary for search/orientation" })),
      tags: Type.Optional(Type.Array(Type.String())),
      attached_to: Type.Optional(Type.String({ description: "Primary entity binding" })),
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
    prepareArguments(args) {
      // Older sessions may replay the previous array-of-one tool shape. Keep
      // the public schema singular while folding that one legacy form before
      // validation; arrays with multiple values remain invalid and fail loudly.
      if (!args || typeof args !== "object") return args as any;
      const input = args as Record<string, unknown>;
      if (!Array.isArray(input.attached_to)) return args as any;
      if (input.attached_to.length === 0) {
        const next = { ...input };
        delete next.attached_to;
        return next as any;
      }
      if (input.attached_to.length === 1 && typeof input.attached_to[0] === "string") {
        return { ...input, attached_to: input.attached_to[0] } as any;
      }
      return args as any;
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd;
      const result = await runLocalWrite({ ...params, cwd }, localDependencies(ctx));
      await refreshAwareness(cwd);
      await refreshSpaceUi(ctx, cwd);
      return localToolResult(result);
    },
  });

  pi.registerTool({
    name: "is_status",
    label: "IS Status",
    description:
      "Show IdeaSpaces capture state. Without path: returns JSON for git position, staged knowledge, and this session's captured paths, then refreshes the UI. With path: returns the full worktree/index/HEAD revision plus compatibility fields for safe refinement, without refreshing the UI. The `change` field always reflects the session's own open-Change record (a Change is session-scoped, spanning repos) — it does not follow a `cwd` override.",
    promptSnippet: "Inspect IdeaSpaces capture state or get a file sha for safe updates",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Optional file path. When present, returns { exists, sha, in_index, modified, in_tracked, revision, session_owned }; use sha as is_write.if_match.",
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
      const result = await runLocalStatus({ ...params, cwd }, localDependencies(ctx));
      if (!result.ok) return localToolResult(result);
      if (params.path) return localToolResult(result);

      // A global status read is also a deliberate UI refresh; single-path
      // revision queries should not rewrite the widget.
      await refreshAwareness(cwd);
      const status = JSON.parse(result.text) as CaptureStatus & {
        session_captures: string[];
      };
      updateSpaceUi(ctx, status);

      // Merge the surface-owned Change state so capture state is one answer:
      // an armed Change (stamping every is_commit), or a record persisted by a
      // previous session / the other surface awaiting explicit resume or close.
      const { armed, rec } = openChangeState(ctx);
      let change: Record<string, unknown> | undefined;
      if (armed) {
        change = { open: armed, ...(rec?.change_id === armed ? { opened_at: rec.opened_at } : {}) };
      } else if (rec) {
        change = {
          persisted: rec.change_id,
          opened_at: rec.opened_at,
          hint: `From a previous session or another surface — resume with is_change_open({ id: "${rec.change_id}" }) or clear with is_change_close.`,
        };
      }
      return ok(JSON.stringify(change ? { ...status, change } : status, null, 2));
    },
  });

  pi.registerTool({
    name: "is_commit",
    label: "IS Commit",
    description:
      "Capture primitive: commit agreed IdeaSpaces changes. Commits only explicit reviewed paths, or this Pi session's captured paths when all=true; never adopts unknown staged work. Timing: an explicit ask to save IS the agreement — act, don't re-ask; at a natural ending, commit and tell the user what was saved; with neither signal, hold and keep staging silently.",
    promptSnippet: "Capture primitive: commit explicit paths or this session's captures — an explicit save-ask is the agreement; narrate, don't re-ask",
    parameters: Type.Object({
      message: Type.String({ description: "Commit message — what understanding this saves, in the user's terms" }),
      paths: Type.Optional(
        Type.Array(Type.String({ description: "Exact path to commit; omit only when all=true" })),
      ),
      all: Type.Optional(
        Type.Boolean({ description: "Commit all paths captured by this Pi extension session instead of explicit paths" }),
      ),
      op: Type.Optional(
        StringEnum(
          ["create", "update", "move", "delete", "restructure", "capture"] as const,
          { description: "Optional Op trailer — the kind of change (the meaning lives in the message body)" },
        ),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // The protocol owns exact-path CAS, staging, commit membership, identity,
      // and trailer validation. Pi supplies only reviewed selection and its
      // session-owned Change/Conversation/co-author context.
      const cwd = params.cwd || ctx.cwd;
      const result = await runLocalCommit({ ...params, cwd }, localDependencies(ctx));
      await refreshAwareness(cwd);
      await refreshSpaceUi(ctx, cwd);
      return localToolResult(result);
    },
  });

  pi.registerTool({
    name: "is_change_open",
    label: "IS Change Open",
    description:
      "Open a Change — an idea-snapshot coordinate stamped as a Change-Id trailer on every commit of one decision, in any repo. Use when a decision will span multiple commits, files, or repos; skip it for a single ordinary commit (there it just duplicates the conversation). Pass `handle` to mint a fresh id, or `id` to continue an existing Change (e.g. recovered from its Note) across sessions.",
    promptSnippet: "Open a Change-Id for a decision spanning multiple commits/repos",
    parameters: Type.Object({
      handle: Type.Optional(
        Type.String({
          description: "Short kebab-ish handle for a new Change, e.g. 'token-bucket'. Ignored if `id` is given.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: "Existing Change-Id (chg_…) to continue across sessions — reuse the id recorded in the Change's Note.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const id = params.id?.trim();
      const handle = params.handle?.trim();
      if (id) {
        currentChangeId = changeId(id, "Provided id");
      } else if (handle) {
        // Repo-agnostic and pure: local Change minting has no CLI boundary.
        currentChangeId = changeId(mintChangeId(handle), "Protocol mint");
      } else {
        throw new Error("Provide `handle` to mint a new Change, or `id` to continue one.");
      }
      persistOpenChange(ctx, currentChangeId, handle);
      return ok(
        `Change open: ${currentChangeId}. It stamps every is_commit until is_change_close. Find its arc later with: git log --grep="Change-Id: ${currentChangeId}"`,
      );
    },
  });

  pi.registerTool({
    name: "is_change_close",
    label: "IS Change Close",
    description:
      "Close the active Change so later commits no longer carry its Change-Id. The decision's arc stays queryable in git history. Also clears a Change record persisted by a previous session or another surface (the one awareness surfaces) when nothing is currently armed — note this clears the shared record only, not another still-running surface's memory.",
    promptSnippet: "Close the active Change-Id",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const file = changeCacheFile(ctx);
      // Resolve BEFORE branching: a same-session pi restart must re-arm here
      // too, or a close issued right after the restart would misreport this
      // session's Change as "previous session".
      const { armed, rec } = openChangeState(ctx);
      if (!armed) {
        if (rec) {
          clearPersistedChange(file);
          return ok(`Cleared persisted Change ${rec.change_id} (opened in a previous session or another surface). Later commits won't carry it.`);
        }
        return ok("No Change is open.");
      }
      currentChangeId = null;
      // Match-before-clear: the shared record is one-per-project-dir, and
      // another surface/session may have opened a DIFFERENT Change since we
      // armed. Closing ours must not delete theirs — clear only when the disk
      // record still describes the Change being closed (or is absent).
      if (!rec || rec.change_id === armed) {
        clearPersistedChange(file);
        return ok(`Change closed: ${armed}.`);
      }
      return ok(
        `Change closed: ${armed}. A different Change (${rec.change_id}) was opened elsewhere since — its record is left in place.`,
      );
    },
  });

  pi.registerTool({
    name: "is_pull",
    label: "IS Pull",
    description:
      "Integrate remote IdeaSpaces changes into the local space (fetch + rebase/merge). Never pushes. Refuses to integrate while staged captures are uncommitted or the tree is dirty. Use through the is-pull skill when the user asks to pull / get the latest / update from remote.",
    promptSnippet: "Pull remote changes into the local space; dry-run before mutating when useful",
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview pull state without fetch or integrate" })),
      rebase: Type.Optional(Type.Boolean({ description: "Use rebase when integrating remote changes (default true)" })),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["pull"];
      if (params.dry_run) args.push("--dry-run");
      if (params.rebase === false) args.push("--rebase=false");
      const result = await runTool(args, undefined, params.cwd || ctx.cwd);
      if (!params.dry_run) {
        await refreshAwareness(params.cwd || ctx.cwd);
        await refreshSpaceUi(ctx, params.cwd || ctx.cwd);
      }
      return result;
    },
  });

  pi.registerTool({
    name: "is_push",
    label: "IS Push",
    description:
      "Push committed IdeaSpaces captures to the remote. Refuses while staged captures are uncommitted, and refuses when behind the remote — pull first. Use through the is-push skill when the user asks to push / share / send.",
    promptSnippet: "Push committed IdeaSpaces captures; dry-run before mutating when useful",
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ description: "Preview push state without fetch or push" })),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const args = ["push"];
      if (params.dry_run) args.push("--dry-run");
      const result = await runTool(args, undefined, params.cwd || ctx.cwd);
      if (!params.dry_run) {
        await refreshAwareness(params.cwd || ctx.cwd);
        await refreshSpaceUi(ctx, params.cwd || ctx.cwd);
      }
      return result;
    },
  });
}
