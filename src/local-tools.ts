import { join, resolve } from "node:path";
import {
  pathRevision,
  stripFrontmatter,
  type LocalEffectCapabilities,
  type LocalEffectTrailers,
  type Op,
  type PathRevision,
} from "@ideaspaces/protocol";
import { commitPaths, writeMarkdown } from "@ideaspaces/protocol/local-effects";
import { SessionCaptureLedger } from "./capture-ledger.js";
import {
  canonicalRepoRoot,
  effectiveGitIdentity,
  localEffectError,
  toPortableRepoPath,
} from "./local-effects-adapter.js";
import { readCaptureStatus } from "./local-awareness.js";
import { buildPiCommitTrailers, resolvePiAgentPrincipal } from "./trailers.js";

export interface LocalToolResult {
  ok: boolean;
  text: string;
}

export interface LocalToolDependencies {
  capabilities: LocalEffectCapabilities;
  ledger: SessionCaptureLedger;
  sessionId(): string | undefined;
  changeId(): string | undefined;
  agentIdEnv?: string;
  processCwd?: string;
}

export interface WriteToolInput {
  path: string;
  content: string;
  name?: string;
  summary?: string;
  tags?: string[];
  attached_to?: string;
  if_match?: string;
  force?: boolean;
  cwd?: string;
}

export interface CommitToolInput {
  message: string;
  paths?: string[];
  all?: boolean;
  op?: Op;
  cwd?: string;
}

function success(value: unknown): LocalToolResult {
  return { ok: true, text: JSON.stringify(value, null, 2) };
}

function failure(value: unknown): LocalToolResult {
  return { ok: false, text: JSON.stringify(value, null, 2) };
}

function effectiveCwd(cwd: string | undefined, deps: LocalToolDependencies): string {
  return resolve(cwd || deps.processCwd || process.cwd());
}

type LocationOperation = "path_revision" | "write_markdown" | "commit_paths";

function locationFailure(
  operation: LocationOperation,
  code: "not_git_repository" | "invalid_path" | "path_escape",
  message: string,
  path: string,
  detail?: string,
): LocalToolResult {
  if (operation === "path_revision") {
    return failure({
      status: "error",
      operation,
      code,
      phase: "preflight",
      path,
      message,
      ...(detail === undefined ? {} : { detail }),
    });
  }
  return failure(localEffectError(operation, code, "preflight", message, path, detail));
}

async function rootAndPath(
  operation: LocationOperation,
  inputPath: string,
  cwd: string,
  deps: LocalToolDependencies,
): Promise<{ root: string; path: string } | LocalToolResult> {
  let root: string;
  try {
    root = await canonicalRepoRoot(cwd, deps.capabilities.git);
  } catch (error) {
    return locationFailure(
      operation,
      "not_git_repository",
      "The operation requires a canonical Git worktree.",
      inputPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  let portable: string | null;
  try {
    portable = await toPortableRepoPath(inputPath, root, cwd);
  } catch (error) {
    return locationFailure(
      operation,
      "invalid_path",
      "The selected path could not be resolved.",
      inputPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!portable) {
    return locationFailure(
      operation,
      "path_escape",
      "The selected path is outside the repository root.",
      inputPath,
    );
  }
  return { root, path: portable };
}

export async function runLocalWrite(
  input: WriteToolInput,
  deps: LocalToolDependencies,
): Promise<LocalToolResult> {
  const cwd = effectiveCwd(input.cwd, deps);
  const location = await rootAndPath("write_markdown", input.path, cwd, deps);
  if ("ok" in location) return location;

  const reviewed = await pathRevision(
    location.root,
    location.path,
    deps.capabilities.git,
    deps.capabilities.filesystem,
  );
  if (reviewed.status === "error") {
    return failure(
      localEffectError(
        "write_markdown",
        reviewed.code,
        reviewed.phase,
        reviewed.message,
        reviewed.path,
        reviewed.detail,
      ),
    );
  }

  let expected: PathRevision | "any";
  if (input.force) {
    expected = "any";
  } else if (input.if_match !== undefined) {
    const fullReview = deps.ledger.reviewedRevision(
      location.root,
      location.path,
      input.if_match,
    );
    if (fullReview) {
      expected = fullReview;
    } else if (reviewed.revision.worktree === input.if_match) {
      expected = reviewed.revision;
    } else {
      return failure(
        localEffectError(
          "write_markdown",
          "revision_mismatch",
          "revision_check",
          `if_match mismatch: expected ${input.if_match}, current ${reviewed.revision.worktree ?? "(file absent)"}.`,
          location.path,
        ),
      );
    }
  } else if (reviewed.revision.worktree !== null) {
    return failure(
      localEffectError(
        "write_markdown",
        "revision_mismatch",
        "revision_check",
        "File exists. Pass if_match for a safe update, or force after reconciling divergent content.",
        location.path,
      ),
    );
  } else {
    expected = reviewed.revision;
  }

  const set: Record<string, string | string[]> = {};
  if (input.name) set.name = input.name;
  if (input.summary) set.summary = input.summary;
  if (input.tags?.length) set.tags = input.tags;
  if (input.attached_to) set.attached_to = input.attached_to;

  const result = await writeMarkdown(
    {
      operation: "write_markdown",
      root: location.root,
      path: location.path,
      expected_revision: expected,
      frontmatter: { mode: "preserve", set, remove: [] },
      body: stripFrontmatter(input.content),
      stage: true,
    },
    deps.capabilities,
  );

  if (result.status === "ok" || result.status === "partial") {
    const current = result.path_revisions.find(({ path }) => path === location.path);
    if (current) deps.ledger.recordCapture(location.root, location.path, current.revision);
  }
  if (result.status !== "ok") return failure(result);

  const revision = result.path_revisions[0]?.revision;
  return success({
    ...result,
    path: join(location.root, ...location.path.split("/")),
    sha: revision?.worktree ?? null,
    staged: revision?.worktree !== null && revision?.index === revision?.worktree,
  });
}

export async function runLocalStatus(
  input: { path?: string; cwd?: string },
  deps: LocalToolDependencies,
): Promise<LocalToolResult> {
  const cwd = effectiveCwd(input.cwd, deps);
  if (!input.path) {
    let status;
    try {
      status = await readCaptureStatus(cwd);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    if (!status) return { ok: false, text: "not inside a git repository" };
    let root: string;
    try {
      root = await deps.capabilities.filesystem.realpath(status.repoRoot);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
    return success({
      ...status,
      repoRoot: root,
      session_captures: deps.ledger.capturedPaths(root),
    });
  }

  const location = await rootAndPath("path_revision", input.path, cwd, deps);
  if ("ok" in location) return location;
  const current = await pathRevision(
    location.root,
    location.path,
    deps.capabilities.git,
    deps.capabilities.filesystem,
  );
  if (current.status === "error") return failure(current);
  deps.ledger.recordReview(location.root, location.path, current.revision);

  const revision = current.revision;
  return success({
    path: input.path,
    exists: revision.worktree !== null,
    sha: revision.worktree,
    in_index: revision.index !== revision.head,
    modified: revision.worktree !== revision.index,
    in_tracked: revision.index !== null,
    revision,
    session_owned: deps.ledger.capturedRevision(location.root, location.path) !== undefined,
  });
}

export async function runLocalCommit(
  input: CommitToolInput,
  deps: LocalToolDependencies,
): Promise<LocalToolResult> {
  const cwd = effectiveCwd(input.cwd, deps);
  let root: string;
  try {
    root = await canonicalRepoRoot(cwd, deps.capabilities.git);
  } catch (error) {
    return failure(
      localEffectError(
        "commit_paths",
        "not_git_repository",
        "preflight",
        "Commit requires a canonical Git worktree.",
        undefined,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  if (input.all && input.paths?.length) {
    return failure(
      localEffectError(
        "commit_paths",
        "invalid_request",
        "preflight",
        "Use exactly one of explicit paths or all.",
      ),
    );
  }

  const usingAll = input.all === true;
  let paths: string[];
  if (usingAll) {
    paths = deps.ledger.capturedPaths(root);
  } else {
    const converted: string[] = [];
    for (const inputPath of input.paths ?? []) {
      let path: string | null;
      try {
        path = await toPortableRepoPath(inputPath, root, cwd);
      } catch (error) {
        return failure(
          localEffectError(
            "commit_paths",
            "invalid_path",
            "preflight",
            "The selected path could not be resolved.",
            inputPath,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      if (!path) {
        return failure(
          localEffectError(
            "commit_paths",
            "path_escape",
            "preflight",
            "The selected path is outside the repository root.",
            inputPath,
          ),
        );
      }
      converted.push(path);
    }
    paths = converted;
  }
  paths = [...new Set(paths)];
  if (paths.length === 0) {
    return failure(
      localEffectError(
        "commit_paths",
        usingAll ? "nothing_to_commit" : "invalid_request",
        usingAll ? "commit" : "preflight",
        usingAll
          ? "This Pi session has no captured paths to commit."
          : "Refusing to commit with no paths. Name paths or use all.",
      ),
    );
  }

  const selected: Array<{ path: string; expected_revision: PathRevision }> = [];
  for (const path of paths) {
    const owned = deps.ledger.capturedRevision(root, path);
    if (owned) {
      selected.push({ path, expected_revision: owned });
      continue;
    }
    const current = await pathRevision(
      root,
      path,
      deps.capabilities.git,
      deps.capabilities.filesystem,
    );
    if (current.status === "error") {
      return failure(
        localEffectError(
          "commit_paths",
          current.code,
          current.phase,
          current.message,
          current.path,
          current.detail,
        ),
      );
    }
    selected.push({ path, expected_revision: current.revision });
  }

  let identity;
  try {
    identity = await effectiveGitIdentity(root, deps.capabilities.git);
  } catch (error) {
    return failure(
      localEffectError(
        "commit_paths",
        "invalid_identity",
        "preflight",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  let trailers: LocalEffectTrailers;
  try {
    trailers = buildPiCommitTrailers(input.op, {
      changeId: deps.changeId(),
      principal: resolvePiAgentPrincipal(deps.agentIdEnv, identity.email),
      sessionId: deps.sessionId(),
    });
  } catch (error) {
    return failure(
      localEffectError(
        "commit_paths",
        "invalid_trailers",
        "preflight",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const result = await commitPaths(
    {
      operation: "commit_paths",
      root,
      paths: selected,
      message: input.message,
      trailers,
      author: identity,
      committer: identity,
    },
    deps.capabilities,
  );

  if (result.status === "partial") {
    deps.ledger.refreshCaptured(root, result.path_revisions);
    return failure(result);
  }
  if (result.status === "error") return failure(result);

  deps.ledger.removeCaptured(root, paths);
  return success({
    ...result,
    commit_sha: result.commit_oid,
    committed_paths: usingAll
      ? paths
      : paths.map((path) => join(root, ...path.split("/"))),
  });
}
