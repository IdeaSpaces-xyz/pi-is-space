import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSpaceRoot,
  composeContractAlongPath,
  assembleAwareness,
  gitState,
  walkPathContext,
  spaceRootLevel,
  currentBranchLevel,
  extractSummary,
} from "@ideaspaces/sdk";

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

// A single working-set handle: a root, a one-line summary, and a top-level dir
// count. Mounts surface as thin handles — orientation, not full trees.
type RootHandle = { summary: string | null; dirCount: number | null };

// First line of a file's content (frontmatter stripped via extractSummary), or
// null. Kept to a single line so working-set handles stay terse.
function firstContentLine(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("---")) return trimmed;
  }
  return null;
}

// Read a one-line summary for a root: prefer `_agent/now.md`, then `README.md`.
// Use the Layer 1 frontmatter summary when present, else the first content line.
async function readRootSummary(root: string): Promise<string | null> {
  const candidates = [join(root, "_agent", "now.md"), join(root, "README.md")];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf-8");
      const summary = extractSummary(content) ?? firstContentLine(content);
      if (summary) return summary.replace(/\s+/g, " ").trim();
    } catch {
      // Missing or unreadable candidate — try the next.
    }
  }
  return null;
}

// Count top-level directories under a root, excluding noise dirs. Best-effort.
async function countTopLevelDirs(root: string): Promise<number | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(
      (entry) => entry.isDirectory() && !AUTOCOMPLETE_EXCLUDES.includes(entry.name),
    ).length;
  } catch {
    return null;
  }
}

async function readRootHandle(root: string): Promise<RootHandle> {
  const [summary, dirCount] = await Promise.all([readRootSummary(root), countTopLevelDirs(root)]);
  return { summary, dirCount };
}

function formatRootHandleLine(label: string, display: string, handle: RootHandle): string {
  const parts = [`  ${label}: ${display}`];
  if (handle.summary) parts.push(` — ${handle.summary}`);
  if (handle.dirCount != null) parts.push(` (${handle.dirCount} dirs)`);
  return parts.join("");
}

// The working-set section: the home root (authority frame) plus read-only
// content mounts, each as a thin handle. Progressive disclosure — handles only,
// never full trees; deepen a mount on demand via is_navigate({ root }).
async function formatWorkingSetSection(homeRoot: string, mounts: string[]): Promise<string | null> {
  const lines = ["Working set:"];
  const homeHandle = await readRootHandle(homeRoot);
  lines.push(formatRootHandleLine("home", basename(homeRoot) || homeRoot, homeHandle));

  const mountHandles = await Promise.all(mounts.map((mount) => readRootHandle(mount)));
  mounts.forEach((mount, index) => {
    lines.push(formatRootHandleLine("mount", mount, mountHandles[index]));
  });

  return lines.join("\n");
}

// One-line sync state for a repo, from gitState: `local-only` (no upstream),
// `synced`, `ahead N`, `behind N`, `diverged +A/-B`; suffixed ` · dirty` when
// the tree is dirty. `unknown` when git state can't be read.
async function readRepoState(repoRoot: string): Promise<string> {
  let state: Awaited<ReturnType<typeof gitState>>;
  try {
    state = await gitState(repoRoot);
  } catch {
    return "unknown";
  }
  let base: string;
  if (state.ahead == null || state.behind == null) {
    base = "local-only";
  } else if (state.ahead > 0 && state.behind > 0) {
    base = `diverged +${state.ahead}/-${state.behind}`;
  } else if (state.ahead > 0) {
    base = `ahead ${state.ahead}`;
  } else if (state.behind > 0) {
    base = `behind ${state.behind}`;
  } else {
    base = "synced";
  }
  return state.dirty ? `${base} · dirty` : base;
}

// Cap on catalog rows so a folder with many repos can't bloat the awareness
// block; the remainder is summarised as "…and N more".
const MAX_CATALOG_REPOS = 20;

// The catalog: git repos that are immediate children of the workspace folder
// (the session cwd / `--context` root), each a thin handle tagged with its sync
// state, the POV, and whether it's mounted. This is the LOCAL tier — the repos
// the agent can navigate into or pull; the remote/pullable tier is added when
// IdeaSpace is connected. Repos only: plain dirs are ordinary files the agent
// reads directly. Returns null when the folder holds no child repos. Immediate
// children only (repos are siblings), not recursive; capped and rendered in
// parallel across repos.
async function formatCatalogSection(
  workspaceFolder: string,
  opts: {
    povRepoRoot: string | null;
    mounts: string[];
    pullable?: Array<{ slug: string; namespace: string }>;
  },
): Promise<string | null> {
  let repos: string[];
  try {
    const entries = await readdir(workspaceFolder, { withFileTypes: true });
    repos = entries
      .filter((entry) => entry.isDirectory() && !AUTOCOMPLETE_EXCLUDES.includes(entry.name))
      .map((entry) => join(workspaceFolder, entry.name))
      .filter((dir) => existsSync(join(dir, ".git")));
  } catch {
    // Unreadable folder: no local tier, but the pullable tier may still render.
    repos = [];
  }
  repos.sort((a, b) => basename(a).localeCompare(basename(b)));

  const pov = opts.povRepoRoot ? resolvePath(opts.povRepoRoot) : null;
  const mountSet = new Set(opts.mounts.map((mount) => resolvePath(mount)));
  // Keep the POV and mounted repos in view even past the cap — the agent's own
  // position must never be the row that gets truncated. Priority repos first,
  // the rest alphabetically, then slice (never below the priority count).
  const isPriority = (repo: string): boolean => {
    const abs = resolvePath(repo);
    return abs === pov || mountSet.has(abs);
  };
  const priority = repos.filter(isPriority);
  const ordered = [...priority, ...repos.filter((repo) => !isPriority(repo))];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = repos.length - shown.length;

  const rows = await Promise.all(
    shown.map(async (repo) => {
      const [summary, state] = await Promise.all([readRootSummary(repo), readRepoState(repo)]);
      const tags = [state];
      if (pov && resolvePath(repo) === pov) tags.push("POV");
      if (mountSet.has(resolvePath(repo))) tags.push("mounted");
      const parts = [`  ${basename(repo)}`];
      if (summary) parts.push(` — ${summary}`);
      parts.push(` (${tags.join(" · ")})`);
      return parts.join("");
    }),
  );

  const blocks: string[] = [];
  if (rows.length) {
    const lines = ["Repos in scope (local):", ...rows];
    if (overflow > 0) lines.push(`  …and ${overflow} more`);
    blocks.push(lines.join("\n"));
  }
  // The remote/pullable tier: account spaces not yet on disk (from the CLI
  // `catalog` verb). Empty when logged out. Pull one to bring it local.
  const pullable = opts.pullable ?? [];
  if (pullable.length) {
    blocks.push(
      [
        "Pullable (remote — not yet local):",
        ...pullable.map((p) => `  ${p.slug} (${p.namespace})`),
        "  → to work on one, clone it into this folder with `ideaspaces clone` (via bash).",
      ].join("\n"),
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

// Awareness is rooted at a *position* — the place the agent's orientation is
// focused — not necessarily the session cwd. `navigate` moves this position;
// when unset, callers pass `ctx.cwd` so behaviour is unchanged. `workspaceFolder`
// is the session cwd (the `--context` root); the catalog scans its child repos.
async function buildAwareness(
  effectivePosition: string,
  mounts: string[] = [],
  workspaceFolder: string = effectivePosition,
  pullable: Array<{ slug: string; namespace: string }> = [],
): Promise<{ root: string | null; repoRoot: string | null; text: string | null }> {
  // Compose the effective fractal contract along the path to the position:
  // `foundation` from the space root, deepest-present guide/purpose/now/next.
  const composed = await composeContractAlongPath(effectivePosition);

  const status = await readCaptureStatus(effectivePosition);
  let repoRoot = status?.repoRoot ?? null;
  if (!repoRoot) {
    try {
      repoRoot = (await gitState(effectivePosition)).repoRoot;
    } catch {
      // No git repo available. Do not substitute the ideaspace root here:
      // space root and git root are different concepts.
      repoRoot = null;
    }
  }

  // The catalog: local repos in the workspace folder (the POV's siblings) plus
  // the remote/pullable tier when logged in.
  const catalog = await formatCatalogSection(workspaceFolder, { povRepoRoot: repoRoot, mounts, pullable });

  // No ideaspace contract at this position: we're at a bare workspace folder (or
  // a plain repo with no `_agent/`). There's no fractal contract to assemble, so
  // the catalog *is* the orientation — which repos are here and their state —
  // plus, at folder level, a nudge to navigate into one.
  if (!composed.spaceRoot) {
    const hint = repoRoot
      ? null
      : "You're at a workspace folder (no `_agent/` contract here). Navigate into a repo below to work in it (is_navigate), or pull one that's behind.";
    const parts = [status ? formatStateSection(status) : null, catalog, hint].filter(Boolean);
    // Report no repoRoot outside an ideaspace: `cachedRepoRoot` gates the
    // `refs/ideaspaces/seen` marker write on shutdown, which must not land in
    // plain repos surfaced by the catalog. The local `repoRoot` above is used
    // only to tag the POV in the catalog; it is not exported here.
    return { root: null, repoRoot: null, text: parts.length ? parts.join("\n\n") : null };
  }

  let lastSha: string | undefined;
  if (repoRoot) {
    // First run (no marker yet) returns undefined — no "since last session" diff.
    lastSha = readSeenMarker(repoRoot);
  }
  const [block, pathContext] = await Promise.all([
    assembleAwareness({
      root: effectivePosition,
      contract: composed.contract,
      lastSha,
    }),
    repoRoot ? walkPathContext(repoRoot, effectivePosition) : Promise.resolve(null),
  ]);
  const drift: string[] = [];
  if (!composed.contract.purpose) {
    drift.push(
      "⚠ `_agent/purpose.md` not yet captured. The contract names it; suggest capturing in conversation when there's a natural moment.",
    );
  }
  if (!composed.contract.now) {
    drift.push(
      "⚠ `_agent/now.md` not yet captured. Suggest capturing what's currently active.",
    );
  }

  // Working set: the home root (authority frame, above) plus read-only content
  // mounts, surfaced as thin handles. Anchored on the space root so "home"
  // names the authority frame, not a deep position within it.
  const workingSet = await formatWorkingSetSection(composed.spaceRoot, mounts);

  const parts = [
    pathContext && repoRoot ? formatPositionSection(effectivePosition, repoRoot, pathContext) : null,
    formatStateSection(status),
    block.trim(),
    workingSet,
    catalog,
    ...drift,
  ].filter(Boolean);
  return { root: composed.spaceRoot, repoRoot, text: parts.length ? parts.join("\n\n") : null };
}

/** Wrap a bare id or principal into `agent:<id>@ideaspaces` (domain platform-set). */
function agentPrincipalFromId(id: string): string {
  const bare = id.replace(/^agent:/, "").replace(/@.*$/, "").trim();
  return `agent:${bare}@ideaspaces`;
}

/** Local git `user.email` for the repo at `cwd`, or null. Offline, read-only. */
function gitConfigUserEmail(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf-8" });
    const v = (r.stdout ?? "").trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the local agent's signing principal, offline: an explicit
 * `IDEASPACES_AGENT_ID` override wins; otherwise derive `agent:<username>-pi`
 * from the person identity the CLI writes to git `user.email`
 * (`person:<username>@ideaspaces`). Returns null when neither is available yet
 * (e.g. a fresh clone before its first identity-bearing commit) — the caller
 * simply omits `Co-authored-by`, which is additive.
 */
function resolveAgentPrincipal(cwd: string): string | null {
  const override = process.env.IDEASPACES_AGENT_ID?.trim();
  if (override) return agentPrincipalFromId(override);
  const email = gitConfigUserEmail(cwd);
  const m = email?.match(/^person:(.+)@ideaspaces$/);
  if (m) return `agent:${m[1]}-pi@ideaspaces`;
  return null;
}

export default function (pi: ExtensionAPI) {
  let cachedAwareness: string | null = null;
  let cachedRoot: string | null = null;
  let cachedRepoRoot: string | null = null;
  // Session-persistent orientation focus. Unset → awareness roots at ctx.cwd.
  // `navigate` moves this; it never touches the session cwd or file-op paths.
  let position: string | null = null;
  // The conversation's working set beyond home: mounted roots (absolute, deduped).
  // Mounts are content, never authority — read-only reference surfaced as thin
  // handles. Mounting never changes `position`/authority, cwd, or file-op paths.
  let mounts: string[] = [];
  // The remote/pullable tier of the catalog: the account's spaces not yet on
  // disk. Fetched once per session via the CLI `catalog` verb (a network call),
  // then cached; empty when logged out. Filled in the background so the first
  // turn never blocks on the network.
  let pullable: Array<{ slug: string; namespace: string }> = [];
  let pullableFetched = false;
  // The active Change — an idea-snapshot coordinate stamped as a Change-Id
  // trailer on every commit of one decision, across repos. Unset → commits carry
  // no Change-Id. Opened with `is_change_open`, cleared with `is_change_close`.
  let currentChangeId: string | null = null;
  // The local agent's signing principal (`agent:<id>@ideaspaces`), resolved once
  // and cached: `IDEASPACES_AGENT_ID` override, else derived from the person
  // identity in git `user.email`. Null until resolved (retried each commit).
  let agentPrincipal: string | null = null;
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
  async function navigateMount(rootArg: string, rawPath: string): Promise<ToolResult> {
    const mountRoot = resolveMount(rootArg);
    if (!mountRoot) {
      const available = mounts.length ? mounts.join(", ") : "(none mounted)";
      return fail(`No mounted root matches "${rootArg}". Mounted roots: ${available}. Use is_mount to add one.`);
    }

    const subPath = rawPath === "" || rawPath === "." ? mountRoot : resolvePath(mountRoot, rawPath);
    if (!isPathInside(subPath, mountRoot)) {
      return fail(`Refusing to look outside the mounted root (${mountRoot}): ${subPath}`);
    }

    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(subPath);
    } catch {
      return fail(`No such path in mount: ${subPath}`);
    }
    if (!stats.isDirectory()) {
      return fail(`Not a directory: ${subPath}`);
    }

    let composed: Awaited<ReturnType<typeof composeContractAlongPath>>;
    let block: string;
    try {
      composed = await composeContractAlongPath(subPath);
      block = await assembleAwareness({
        root: subPath,
        contract: composed.contract,
        lastSha: undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Failed to read mounted content at ${subPath}: ${message}`);
    }

    const rel = relative(mountRoot, subPath) || ".";
    const header = [
      "Mounted content (read-only) — its `_agent/` is reference, not your operating contract.",
      `mount: ${mountRoot}`,
      `position: ${rel}`,
    ];
    if (composed.spaceRoot) header.push(`mount space root: ${composed.spaceRoot}`);
    const body = block.trim();
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
      const awareness = await buildAwareness(effectivePosition(cwd), mounts, cwd, pullable);
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

  pi.on("session_start", async (_event, ctx) => {
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
      "Move your awareness focus to a position in the space — re-derives orientation (purpose/now/guide/tree) for that branch using the fractal-composed contract. Does not change the working directory; read/edit/bash still take explicit paths. Pass `root` with a mounted root (from is_mount) to look into that mount instead: returns its composed view at `path` as read-only content — a mount's _agent/ is reference, never your operating contract — and never changes your authority position.",
    promptSnippet: "Re-root orientation at a branch of home (orientation only; cwd unchanged), or look into a mounted root as read-only content",
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
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rootArg = params.root?.trim();
      if (rootArg && rootArg !== "home") {
        return navigateMount(rootArg, params.path.trim());
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
        return fail(`No such path: ${target}`);
      }
      if (!stats.isDirectory()) {
        return fail(`Not a directory: ${target}`);
      }
      if (!isPathInside(target, repoRoot)) {
        return fail(`Refusing to navigate outside the repo root (${repoRoot}): ${target}`);
      }

      await setPosition(target, ctx.cwd);

      const rel = relative(repoRoot, target) || ".";
      const lines = [`Awareness focus moved to ${rel} (working directory unchanged).`];
      if (cachedRoot) lines.push(`space root: ${cachedRoot}`);
      const nowLine = cachedAwareness?.split("\n").find((line) => line.startsWith("Now:"));
      if (nowLine) lines.push(nowLine);
      else if (cachedAwareness === null) lines.push("No _agent/ contract resolves at this position.");
      return ok(lines.join("\n"));
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
      if (!raw) return fail("Provide a path to mount.");
      const target = resolvePath(homeRoot, raw);

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(target);
      } catch {
        return fail(`No such path: ${target}`);
      }
      if (!stats.isDirectory()) {
        return fail(`Not a directory: ${target}`);
      }
      if (isPathInside(target, homeRoot)) {
        return fail(`Already reachable from home (${homeRoot}); no mount needed: ${target}`);
      }
      if (!addMount(target)) {
        return fail(`Already mounted: ${target}`);
      }

      await refreshAwareness(ctx.cwd);

      const handle = await readRootHandle(target);
      const lines = [`Mounted (read-only): ${target}`];
      if (handle.summary) lines.push(`  ${handle.summary}`);
      lines.push("Surfaced as a working-set handle. Look inside with is_navigate({ root, path }). It is content, not authority.");
      return ok(lines.join("\n"));
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
      if (!raw) return fail("Provide a mounted root to remove.");

      const removed = removeMount(raw);
      if (!removed) {
        const available = mounts.length ? mounts.join(", ") : "(none mounted)";
        return fail(`Not mounted: ${raw}. Mounted roots: ${available}.`);
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
        Type.Union([Type.Literal("login"), Type.Literal("logout")]),
      ),
    }),
    async execute(_id, params) {
      const action = params.action ?? "login";
      switch (action) {
        case "login": {
          const result = await run(["login"]);
          if (!isErrorResult(result)) {
            // Now possibly logged in — re-fetch the pullable tier next turn.
            pullableFetched = false;
          }
          return result;
        }
        case "logout": {
          const result = await run(["power", "logout"]);
          if (!isErrorResult(result)) {
            cachedAwareness = null;
            cachedRoot = null;
            cachedRepoRoot = null;
            // Drop the remote tier immediately; the next turn re-fetches (→ empty).
            pullable = [];
            pullableFetched = false;
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
        await refreshAwareness(cwd);
        await refreshSpaceUi(ctx, cwd);
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
      op: Type.Optional(
        Type.Union(
          [
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("move"),
            Type.Literal("delete"),
            Type.Literal("restructure"),
            Type.Literal("capture"),
          ],
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
      // Stamp the Change layer by handing the trailer inputs to `cli commit`,
      // which folds them into the message — the CLI (and the SDK beneath it)
      // own the trailer format and validation. Per-commit provenance rides
      // every agent-driven commit: Co-authored-by (the agent principal that
      // assisted) + Conversation (the pi session id); Change-Id + Op ride only
      // when set. Author stays the person (CLI-set). All additive.
      const cwd = params.cwd || ctx.cwd;
      if (!agentPrincipal) agentPrincipal = resolveAgentPrincipal(cwd);
      const sessionId = ctx.sessionManager.getSessionId();

      const args = ["commit", "-m", params.message];
      if (params.all) args.push("--all");
      else if (params.paths?.length) args.push(...params.paths);
      if (params.op) args.push("--op", params.op);
      if (currentChangeId) args.push("--change-id", currentChangeId);
      if (agentPrincipal) args.push("--co-author", agentPrincipal);
      if (sessionId) args.push("--conversation", sessionId);

      const result = await run(args, undefined, cwd);
      if (!isErrorResult(result)) {
        await refreshAwareness(cwd);
        await refreshSpaceUi(ctx, cwd);
      }
      return result;
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
    async execute(_id, params) {
      const id = params.id?.trim();
      if (id) {
        // Continue an existing Change across sessions. The CLI validates the id
        // when it stamps (`cli commit --change-id` rejects a malformed id), so
        // we don't re-check — all Change-Id knowledge stays in the CLI/SDK.
        currentChangeId = id;
      } else if (params.handle?.trim()) {
        // Mint offline via the CLI — a repo-agnostic, pure mint.
        const minted = await runJson<{ change_id: string }>(["change", "new", params.handle.trim()]);
        if (!minted.ok) return fail(minted.error);
        currentChangeId = minted.data.change_id;
      } else {
        return fail("Provide `handle` to mint a new Change, or `id` to continue one.");
      }
      return ok(
        `Change open: ${currentChangeId}. It stamps every is_commit until is_change_close. Find its arc later with: git log --grep="Change-Id: ${currentChangeId}"`,
      );
    },
  });

  pi.registerTool({
    name: "is_change_close",
    label: "IS Change Close",
    description:
      "Close the active Change so later commits no longer carry its Change-Id. The decision's arc stays queryable in git history.",
    promptSnippet: "Close the active Change-Id",
    parameters: Type.Object({}),
    async execute() {
      if (!currentChangeId) return ok("No Change is open.");
      const closed = currentChangeId;
      currentChangeId = null;
      return ok(`Change closed: ${closed}.`);
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
      const result = await run(args, undefined, params.cwd || ctx.cwd);
      if (!isErrorResult(result) && !params.dry_run) {
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
      const result = await run(args, undefined, params.cwd || ctx.cwd);
      if (!isErrorResult(result) && !params.dry_run) {
        await refreshAwareness(params.cwd || ctx.cwd);
        await refreshSpaceUi(ctx, params.cwd || ctx.cwd);
      }
      return result;
    },
  });
}
