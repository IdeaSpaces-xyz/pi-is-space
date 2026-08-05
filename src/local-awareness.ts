import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import {
  assembleContentAwareness,
  gitState,
  pathStatus,
  readRootHandle,
  readWorkspaceRepositories,
  renderContentAwareness,
  resolveRepoRoot,
  stagedIdeaspacePaths,
  type GitState,
  type RootHandle,
  type WorkspaceRepository,
} from "@ideaspaces/protocol";

export type CaptureStatus = {
  repoRoot: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  untracked_in_tracked_dirs: string[];
  tracked_captures: string[];
};

export type PullableSpace = { slug: string; namespace: string };

export interface LocalAwarenessResult {
  root: string | null;
  repoRoot: string | null;
  text: string | null;
}

export const LOCAL_WORKSPACE_EXCLUDES = ["backups", ".pi", ".claude"] as const;

const MAX_CATALOG_REPOS = 20;
const CORE_SECTIONS = [
  "position",
  "now",
  "tree",
  "contract",
  "skills",
  "activity",
] as const;
const DRIFT_SECTIONS = ["stale-docs", "direction-drift"] as const;

const BARE_FOLDER_HINT =
  "You're at a workspace folder (no `_agent/` contract here). Navigate into a repo below (`ideaspaces navigate <repo>`), or pull one that's behind.";
const EMPTY_FOLDER_HINT =
  "You're at a workspace folder with no repos yet. Clone one to get started (`ideaspaces clone`).";

export async function readCaptureStatus(cwd: string): Promise<CaptureStatus | null> {
  const repoRoot = await resolveRepoRoot(resolve(cwd));
  if (!repoRoot) return null;
  const [state, captures] = await Promise.all([
    gitState(repoRoot),
    stagedIdeaspacePaths(repoRoot),
  ]);
  return captureStatus(state, captures);
}

export async function readPathStatusText(
  cwd: string,
  rawPath: string,
): Promise<string> {
  const repoRoot = await resolveRepoRoot(resolve(cwd));
  if (!repoRoot) throw new Error("not inside a git repository");
  const status = await pathStatus(resolve(cwd, rawPath), repoRoot);
  return JSON.stringify(
    {
      path: rawPath,
      exists: status.exists,
      sha: status.sha,
      in_index: status.inIndex,
      modified: status.modified,
      in_tracked: status.inTracked,
    },
    null,
    2,
  );
}

/** Compose Pi's combined awareness while keeping placement and workspace roles local. */
export async function buildLocalAwareness(opts: {
  position: string;
  workspace: string;
  mounts?: string[];
  pullable?: PullableSpace[];
}): Promise<LocalAwarenessResult> {
  const position = resolve(opts.position);
  const workspace = resolve(opts.workspace);
  const mounts = opts.mounts ?? [];
  const pullable = opts.pullable ?? [];

  const focusedRepoRootPromise = resolveRepoRoot(position).catch(() => null);
  const [status, manifestRead, focusedRepoRoot, catalog] = await Promise.all([
    readCaptureStatus(position).catch((error) => {
      console.warn(`IdeaSpaces: status read failed: ${errorMessage(error)}`);
      return null;
    }),
    settle(assembleContentAwareness({ position })),
    focusedRepoRootPromise,
    formatCatalogSection(workspace, focusedRepoRootPromise, mounts, pullable).catch(
      (error) => `⚠ workspace catalog read failed: ${errorMessage(error)}`,
    ),
  ]);

  const state = formatStateSection(status);
  if (!manifestRead.ok) {
    // Preserve the old failure boundary: if orientation itself unexpectedly
    // fails, keep any independently-read operating state instead of blanking
    // the whole awareness block.
    console.warn(`IdeaSpaces: Content awareness read failed: ${errorMessage(manifestRead.error)}`);
    return { root: null, repoRoot: null, text: state };
  }

  const manifest = manifestRead.value;
  if (!manifest) {
    const hint = !focusedRepoRoot && !catalog?.startsWith("⚠")
      ? catalog
        ? BARE_FOLDER_HINT
        : EMPTY_FOLDER_HINT
      : null;
    const text = joinSections([state, catalog, hint]);
    return { root: null, repoRoot: null, text };
  }

  const core = renderContentAwareness(manifest, { sections: CORE_SECTIONS });
  const workingSet = await formatWorkingSetSection(manifest.spaceRoot, mounts);
  const drift = renderContentAwareness(manifest, { sections: DRIFT_SECTIONS });
  const text = joinSections([state, core, workingSet, catalog, drift]);
  return {
    root: manifest.spaceRoot,
    repoRoot: manifest.position.repoRoot,
    text,
  };
}

/** Render a mounted Content position without importing its contract as authority. */
export async function readMountedAwareness(
  position: string,
  treeDepth?: number,
): Promise<{
  root: string | null;
  text: string | null;
}> {
  const manifest = await assembleContentAwareness({
    position: resolve(position),
    ...(treeDepth ? { treeDepth } : {}),
  });
  if (!manifest) return { root: null, text: null };
  return {
    root: manifest.spaceRoot,
    text: renderContentAwareness(manifest, {
      sections: [...CORE_SECTIONS, ...DRIFT_SECTIONS],
    }) || null,
  };
}

/**
 * One-shot map probe at a position: the tree section at the given depth,
 * rendered as tool output. Never touches the persistent awareness block —
 * ambient orientation stays at depth 1; probing is deliberate and ephemeral.
 */
export async function probeTree(position: string, treeDepth: number): Promise<string | null> {
  const manifest = await assembleContentAwareness({
    position: resolve(position),
    lastSha: null,
    treeDepth,
  });
  if (!manifest) return null;
  return renderContentAwareness(manifest, { sections: ["tree"] }) || null;
}

function captureStatus(state: GitState, captures: string[]): CaptureStatus {
  return {
    repoRoot: state.repoRoot,
    branch: state.branch,
    ahead: state.ahead,
    behind: state.behind,
    dirty: state.dirty,
    untracked_in_tracked_dirs: state.untrackedInTrackedDirs,
    tracked_captures: captures,
  };
}

function formatStateSection(status: CaptureStatus | null): string | null {
  if (!status) return null;
  const lines = ["State:", `  branch: ${status.branch ?? "(detached)"}`];
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

async function formatWorkingSetSection(
  homeRoot: string,
  mounts: string[],
): Promise<string> {
  const options = { excludeDirectories: LOCAL_WORKSPACE_EXCLUDES };
  const [home, ...mounted] = await Promise.all([
    readRootHandle(homeRoot, options),
    ...mounts.map((mount) => readRootHandle(mount, options)),
  ]);
  const lines = [
    "Working set:",
    formatRootHandleLine("home", basename(homeRoot) || homeRoot, home),
  ];
  mounts.forEach((mount, index) => {
    lines.push(formatRootHandleLine("mount", mount, mounted[index]));
  });
  return lines.join("\n");
}

function formatRootHandleLine(
  label: string,
  display: string,
  handle: RootHandle,
): string {
  const parts = [`  ${label}: ${display}`];
  if (handle.summary) parts.push(` — ${handle.summary}`);
  if (handle.directoryCount != null) parts.push(` (${handle.directoryCount} dirs)`);
  return parts.join("");
}

async function formatCatalogSection(
  workspace: string,
  povRepoRootPromise: Promise<string | null>,
  mounts: string[],
  pullable: PullableSpace[],
): Promise<string | null> {
  try {
    if (!(await fs.stat(workspace)).isDirectory()) {
      return `⚠ --workspace is not a readable directory: ${workspace} (catalog skipped)`;
    }
  } catch {
    return `⚠ --workspace is not a readable directory: ${workspace} (catalog skipped)`;
  }

  const [repositories, povRepoRoot] = await Promise.all([
    readWorkspaceRepositories(workspace, {
      excludeDirectories: LOCAL_WORKSPACE_EXCLUDES,
    }),
    povRepoRootPromise,
  ]);
  const pov = povRepoRoot ? resolve(povRepoRoot) : null;
  const mountSet = new Set(mounts.map((mount) => resolve(mount)));
  const isPriority = (repository: WorkspaceRepository): boolean => {
    const root = resolve(repository.root);
    const identity = resolve(repository.git.repoRoot);
    return identity === pov || mountSet.has(root) || mountSet.has(identity);
  };
  const priority = repositories.filter(isPriority);
  const ordered = [
    ...priority,
    ...repositories.filter((repository) => !isPriority(repository)),
  ];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = repositories.length - shown.length;

  const blocks: string[] = [];
  if (shown.length) {
    const lines = [
      "Repos in scope (local):",
      ...shown.map((repository) => formatRepositoryLine(repository, pov, mountSet)),
    ];
    if (overflow > 0) lines.push(`  …and ${overflow} more`);
    blocks.push(lines.join("\n"));
  }
  if (pullable.length) {
    blocks.push(
      [
        "Pullable (remote — not yet local):",
        ...pullable.map((entry) => `  ${entry.slug} (${entry.namespace})`),
        "  → to work on one, clone it into this folder with `ideaspaces clone` (via bash).",
      ].join("\n"),
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

function formatRepositoryLine(
  repository: WorkspaceRepository,
  pov: string | null,
  mounts: ReadonlySet<string>,
): string {
  const root = resolve(repository.root);
  const identity = resolve(repository.git.repoRoot);
  const tags = [formatRepoState(repository.git)];
  if (pov && identity === pov) tags.push("POV");
  if (mounts.has(root) || mounts.has(identity)) tags.push("mounted");
  const parts = [`  ${basename(repository.root)}`];
  if (repository.summary) parts.push(` — ${repository.summary}`);
  parts.push(` (${tags.join(" · ")})`);
  return parts.join("");
}

function formatRepoState(state: GitState): string {
  let value: string;
  if (state.ahead == null || state.behind == null) value = "local-only";
  else if (state.ahead > 0 && state.behind > 0) {
    value = `diverged +${state.ahead}/-${state.behind}`;
  } else if (state.ahead > 0) value = `ahead ${state.ahead}`;
  else if (state.behind > 0) value = `behind ${state.behind}`;
  else value = "synced";
  return state.dirty ? `${value} · dirty` : value;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinSections(sections: Array<string | null | undefined>): string | null {
  const present = sections.filter((section): section is string => Boolean(section?.trim()));
  return present.length ? present.join("\n\n") : null;
}
