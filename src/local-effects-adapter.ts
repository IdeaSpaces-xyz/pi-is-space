import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  LocalEffectCapabilities,
  LocalEffectError,
  LocalEffectIdentity,
  LocalEffectOperation,
  LocalGitResult,
  LocalGitRunner,
} from "@ideaspaces/protocol";
import { nodeLocalEffectFileSystem } from "@ideaspaces/protocol/local-effects";

const BLOCKED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** Remove ambient Git overrides that could replace explicit effect inputs. */
export function localEffectGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of BLOCKED_GIT_ENV) delete env[key];
  return env;
}

/** Pi-owned stock-Git capability. It never uses a shell or platform client. */
export const localEffectGitRunner: LocalGitRunner = async (root, args) =>
  new Promise<LocalGitResult>((done) => {
    const proc = spawn("git", [...args], {
      cwd: root,
      env: localEffectGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    proc.on("close", (code) => done({ ok: code === 0, stdout, stderr, code }));
    proc.on("error", (error) =>
      done({ ok: false, stdout: "", stderr: error.message, code: null }),
    );
  });

export const localEffectCapabilities: LocalEffectCapabilities = {
  git: localEffectGitRunner,
  filesystem: nodeLocalEffectFileSystem,
};

/** Resolve the canonical worktree root through the injected local Git runner. */
export async function canonicalRepoRoot(
  cwd: string,
  git: LocalGitRunner = localEffectGitRunner,
): Promise<string> {
  const invocationDir = await realpath(resolve(cwd));
  const top = await git(invocationDir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout.trim()) {
    throw new Error(top.stderr?.trim() || "not inside a git repository");
  }
  return realpath(top.stdout.trim());
}

/** Convert one caller spelling to a confined portable repository path. */
export async function toPortableRepoPath(
  input: string,
  root: string,
  cwd: string,
): Promise<string | null> {
  const invocationDir = await realpath(resolve(cwd));
  const absolute = isAbsolute(input) ? resolve(input) : resolve(invocationDir, input);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Resolve the person's complete effective Git identity without mutating config. */
export async function effectiveGitIdentity(
  root: string,
  git: LocalGitRunner,
): Promise<LocalEffectIdentity> {
  const [nameResult, emailResult] = await Promise.all([
    git(root, ["config", "--get", "user.name"]),
    git(root, ["config", "--get", "user.email"]),
  ]);
  const name = nameResult.ok ? nameResult.stdout.trim() : "";
  const email = emailResult.ok ? emailResult.stdout.trim() : "";
  if (!name || !email) {
    const detail = [nameResult.stderr, emailResult.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      detail ||
        "No complete Git identity. Configure user.name and user.email for this repository or user.",
    );
  }
  return { name, email };
}

export function localEffectError(
  operation: LocalEffectOperation,
  code: LocalEffectError["code"],
  phase: LocalEffectError["phase"],
  message: string,
  path?: string,
  detail?: string,
): LocalEffectError {
  return {
    status: "error",
    operation,
    affected_paths: [],
    code,
    phase,
    ...(path === undefined ? {} : { path }),
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    message,
  };
}
