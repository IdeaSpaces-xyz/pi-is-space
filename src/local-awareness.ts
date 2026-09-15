import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import {
  assembleContentAwareness,
  assembleContentFocus,
  assembleContentLook,
  assembleContentState,
  composeContractAlongPath,
  discoverSkillEntries,
  projectRootMapMembers,
  readRootHandle,
  readWorkspaceRepositories,
  renderContentAwareness,
  renderContentFocus,
  renderContentLook,
  renderContentTail,
  renderRootMapMembers,
  resolveRepoRoot,
  type ContentState,
  type ContractSource,
  type GitState,
  type MapDepth,
  type RootMapMemberInput,
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
  /**
   * The cache-stable register: position, Now, tree, contract, skills, working
   * set. Deterministic bytes for unchanged state — safe in the system prompt;
   * a changed byte is a legitimate, content-hash invalidation (a capture
   * landed or the starting coordinate changed), never per-turn churn.
   */
  stable: string | null;
  /**
   * The volatile register: the protocol's one Content-tail composition —
   * local State, catalog/floor hint, then the manifest tail (activity and
   * drift). The open Change line joins it at request time, last. Changes
   * freely; must never enter the cached prefix — appended after the last
   * cache breakpoint in before_provider_request. Byte-identical to the CLI's
   * `status` for the same inputs.
   */
  volatile: string | null;
}

export const LOCAL_WORKSPACE_EXCLUDES = ["backups", ".pi", ".claude"] as const;

const MAX_CATALOG_REPOS = 20;

// Harness copy, not protocol shape: these name the CLI commands Pi exposes.
const BARE_WORKSPACE_HINT =
  "You're at a workspace folder (no `_agent/` contract here). Navigate into a repo below (`ideaspaces navigate <repo>`), or pull one that's behind.";
const EMPTY_WORKSPACE_HINT =
  "You're at a workspace folder with no repos yet. Clone one to get started (`ideaspaces clone`).";

function floorHint(
  repoRoot: string | null,
  catalog: string | null,
): string | null {
  if (repoRoot || catalog?.startsWith("⚠")) return null;
  return catalog ? BARE_WORKSPACE_HINT : EMPTY_WORKSPACE_HINT;
}

export async function readCaptureStatus(cwd: string): Promise<CaptureStatus | null> {
  const state = await readContentState(cwd);
  return state ? captureStatus(state.git, state.captures) : null;
}

async function readContentState(cwd: string): Promise<ContentState | null> {
  const repoRoot = await resolveRepoRoot(resolve(cwd));
  return repoRoot ? assembleContentState(repoRoot) : null;
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
  const [state, manifestRead, focusedRepoRoot, catalog] = await Promise.all([
    readContentState(position).catch((error) => {
      console.warn(`IdeaSpaces: status read failed: ${errorMessage(error)}`);
      return null;
    }),
    settle(assemblePreferredContentAwareness(position)),
    focusedRepoRootPromise,
    formatCatalogSection(workspace, focusedRepoRootPromise, mounts, pullable).catch(
      (error) => `⚠ workspace catalog read failed: ${errorMessage(error)}`,
    ),
  ]);

  if (!manifestRead.ok) {
    // Preserve the old failure boundary: if orientation itself unexpectedly
    // fails, keep any independently-read operating state instead of blanking
    // the whole awareness block. State is volatile; nothing stable resolves.
    console.warn(`IdeaSpaces: Content awareness read failed: ${errorMessage(manifestRead.error)}`);
    return { root: null, repoRoot: null, stable: null, volatile: renderContentTail(null, { state }) || null };
  }

  const manifest = manifestRead.value;
  if (!manifest) {
    const hint = floorHint(focusedRepoRoot, catalog);
    // No contract resolves: everything is workspace/session state — volatile
    // by nature, and keeping the system prompt untouched is cache-optimal.
    const volatile = renderContentTail(null, { state, handles: [catalog, hint] }) || null;
    return { root: null, repoRoot: null, stable: null, volatile };
  }

  const stableCore = renderContentAwareness(manifest, { placement: "head" });
  const isFloor = manifest.contractSource === null;
  const workingSet = isFloor
    ? null
    : await formatWorkingSetSection(manifest.spaceRoot, mounts);
  const hint = isFloor ? floorHint(focusedRepoRoot, catalog) : null;
  return {
    root: manifest.spaceRoot,
    repoRoot: manifest.position.repoRoot,
    stable: joinSections([stableCore, workingSet]),
    // The protocol owns the tail composition: State supersedes the compact Git
    // line, forest handles keep producer order, the manifest tail is last. The
    // same call renders the CLI's `status`, so the two cannot drift.
    volatile: renderContentTail(manifest, { state, handles: [catalog, hint] }) || null,
  };
}

/**
 * The per-request tail: the cached volatile register plus the open Change
 * line, placed by the protocol's composition (Change last) rather than by a
 * local join, so the request payload matches `renderContentTail` with the
 * same Change input.
 */
export function withOpenChange(volatile: string | null, change: string | undefined): string {
  return renderContentTail(null, { handles: [volatile], change });
}

/**
 * Append the volatile tail OUTSIDE the cached prefix. Pi places the history
 * cache breakpoint on the last user-role message's last content block; a text
 * block pushed after it is never part of any cached prefix, so per-call churn
 * costs only itself. Mutates the payload in place. Returns false (payload
 * untouched) for shapes it does not recognize — a provider without this
 * layout keeps its default behavior.
 */
export function appendVolatileTail(payload: unknown, text: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    if (!Array.isArray(message.content)) return false;
    message.content.push({ type: "text", text });
    return true;
  }
  return false;
}

/** Render one Content target at a canonical rung without importing its contract as authority. */
export async function readLookAwareness(
  position: string,
  depth: MapDepth = "summary",
  contractSource?: ContractSource,
): Promise<{
  root: string | null;
  text: string | null;
  contractSource: ContractSource | null;
}> {
  const request = {
    position: resolve(position),
    depth,
    ...(contractSource ? { contractSource } : {}),
  };
  let looked = await assembleContentLook(request);
  if (looked?.status === "contract_choice_required" && !contractSource) {
    looked = await assembleContentLook({ ...request, contractSource: "agreement" });
  }
  if (!looked) return { root: null, text: null, contractSource: null };
  const rendered = renderContentLook(looked);
  if (looked.status !== "ok") throw new Error(rendered);
  return {
    root: looked.reference.spaceRoot,
    text: rendered,
    contractSource: looked.reference.contractSource,
  };
}

/** Render a Content position as history reference without importing its contract as authority. */
export async function readFocusedAwareness(
  position: string,
  treeDepth?: number,
): Promise<{
  root: string | null;
  text: string | null;
}> {
  let focus = await assembleContentFocus({ position: resolve(position) });
  if (focus?.status === "contract_choice_required") {
    focus = await assembleContentFocus({
      position: resolve(position),
      contractSource: "agreement",
    });
  }
  if (!focus) return { root: null, text: null };
  const rendered = renderContentFocus(focus);
  // An interactive focus surfaces diagnostics as tool errors; ambient assembly
  // separately catches its throw so session start can preserve volatile state.
  if (focus.status !== "ok") throw new Error(rendered);
  const probe = treeDepth && treeDepth > 1
    ? await probeTree(position, treeDepth)
    : null;
  return {
    root: focus.spaceRoot,
    text: joinSections([
      rendered,
      probe ? `One-shot tree probe:\n${probe}` : null,
    ]),
  };
}

/**
 * Native Pi skill paths for the space at `cwd` — the SKILLS-2 placement model:
 * only the space root's `_agent/skills/` entries are acquired at session start
 * (the persona's abilities); branch skills stay awareness-discovered as focus
 * moves. Entry paths are passed individually so the roster follows the
 * protocol's rules (both forms, directory-beats-flat, README excluded) rather
 * than Pi's own directory walk. Returns [] outside a foundation-marked space,
 * when the root carries no skills, or on any read failure — this fires on
 * every /new, /resume, /fork, and reload, and must never throw into Pi's
 * event loop.
 */
export async function discoverSpaceSkillPaths(cwd: string): Promise<string[]> {
  try {
    const composed = await composeContractAlongPath(cwd);
    if (!composed.spaceRoot) return [];
    const entries = await discoverSkillEntries([composed.spaceRoot]);
    return entries.map((entry) => entry.path);
  } catch (error) {
    console.warn(`is: space skill discovery unavailable: ${String(error)}`);
    return [];
  }
}

/**
 * One-shot map probe at a position: the tree section at the given depth,
 * rendered as tool output. Never touches the persistent awareness block —
 * ambient orientation stays at depth 1; probing is deliberate and ephemeral.
 */
export async function probeTree(position: string, treeDepth: number): Promise<string | null> {
  const manifest = await assemblePreferredContentAwareness(position, treeDepth);
  if (!manifest) return null;
  return renderContentAwareness(manifest, { sections: ["tree"] }) || null;
}

async function assemblePreferredContentAwareness(
  position: string,
  treeDepth?: number,
) {
  const opts = {
    position: resolve(position),
    ...(treeDepth ? { treeDepth } : {}),
  };
  let manifest = await assembleContentAwareness(opts);
  if (manifest?.status === "contract_choice_required") {
    manifest = await assembleContentAwareness({
      ...opts,
      contractSource: "agreement",
    });
  }
  if (manifest && manifest.status === undefined) {
    // A manifest without `status` predates protocol 0.17 — the installed
    // dependency is behind the pin. Say so instead of rendering a healthy
    // block as the failure text.
    throw new Error(
      "@ideaspaces/protocol manifest has no status — installed dependency is " +
        "older than the pinned version; run npm ci in the extension package",
    );
  }
  if (manifest && manifest.status !== "ok") {
    throw new Error(renderContentAwareness(manifest));
  }
  return manifest;
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

async function formatWorkingSetSection(
  homeRoot: string,
  mounts: string[],
): Promise<string | null> {
  const options = { excludeDirectories: LOCAL_WORKSPACE_EXCLUDES };
  const [home, ...mounted] = await Promise.all([
    readRootHandle(homeRoot, options),
    ...mounts.map((mount) => readRootHandle(mount, options)),
  ]);
  const inputs: RootMapMemberInput[] = [
    {
      root: 0,
      name: basename(homeRoot) || homeRoot,
      summary: home.summary,
      presentation: {
        label: "home",
        display: basename(homeRoot) || homeRoot,
        details: home.directoryCount == null ? [] : [`${home.directoryCount} dirs`],
      },
    },
    ...mounts.map((mount, index): RootMapMemberInput => ({
      root: index + 1,
      name: basename(mount) || mount,
      summary: mounted[index]?.summary,
      presentation: {
        label: "mount",
        display: mount,
        details: mounted[index]?.directoryCount == null
          ? []
          : [`${mounted[index]?.directoryCount} dirs`],
      },
    })),
  ];
  return renderRootMapMembers(projectRootMapMembers(inputs), {
    heading: "Working set:",
  });
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
    return root === pov || identity === pov || mountSet.has(root) || mountSet.has(identity);
  };
  const priority = repositories.filter(isPriority);
  const ordered = [
    ...priority,
    ...repositories.filter((repository) => !isPriority(repository)),
  ];
  const shown = ordered.slice(0, Math.max(MAX_CATALOG_REPOS, priority.length));
  const overflow = repositories.length - shown.length;

  const localInputs = shown.map((repository, index): RootMapMemberInput => {
    const root = resolve(repository.root);
    const identity = resolve(repository.git.repoRoot);
    const details = [formatRepoState(repository.git)];
    if (pov && (root === pov || identity === pov)) details.push("POV");
    if (mountSet.has(root) || mountSet.has(identity)) details.push("mounted");
    return {
      root: index,
      name: basename(repository.root) || repository.root,
      summary: repository.summary,
      presentation: {
        display: basename(repository.root) || repository.root,
        details,
      },
    };
  });

  const blocks: string[] = [];
  const local = renderRootMapMembers(projectRootMapMembers(localInputs), {
    heading: "Repos in scope (local):",
    omittedMembers: overflow,
  });
  if (local) blocks.push(local);

  const remote = renderRootMapMembers(
    projectRootMapMembers(
      pullable.map((entry): RootMapMemberInput => ({
        name: entry.slug,
        presentation: { details: [entry.namespace] },
      })),
    ),
    { heading: "Pullable (remote — not yet local):" },
  );
  if (remote) {
    blocks.push(
      `${remote}\n  → to work on one, clone it into this folder with \`ideaspaces clone\` (via bash).`,
    );
  }
  return blocks.length ? blocks.join("\n\n") : null;
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
