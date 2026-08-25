import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRepoRoot,
  effectiveGitIdentity,
  localEffectGitEnvironment,
  localEffectGitRunner,
  toPortableRepoPath,
} from "./local-effects-adapter.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-adapter-")));
  cleanups.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", root, "config", "user.email", "person:test@example.com"]);
  return root;
}

describe("local effect adapter", () => {
  it("removes structural and identity overrides without dropping ordinary env", () => {
    const env = localEffectGitEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      GIT_DIR: "/wrong",
      GIT_INDEX_FILE: "/wrong-index",
      GIT_AUTHOR_NAME: "Wrong",
      GIT_COMMITTER_EMAIL: "wrong@example.com",
    });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/test" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it("resolves one canonical root and confines portable paths", async () => {
    const root = repo();
    const nested = join(root, "nested");
    mkdirSync(nested);

    await expect(canonicalRepoRoot(nested)).resolves.toBe(root);
    await expect(toPortableRepoPath("note.md", root, nested)).resolves.toBe(
      "nested/note.md",
    );
    await expect(toPortableRepoPath(join(root, "other.md"), root, nested)).resolves.toBe(
      "other.md",
    );
    await expect(toPortableRepoPath("../../outside.md", root, nested)).resolves.toBeNull();
  });

  it("reads complete effective identity through the injected runner", async () => {
    const root = repo();
    await expect(effectiveGitIdentity(root, localEffectGitRunner)).resolves.toEqual({
      name: "Test Person",
      email: "person:test@example.com",
    });
  });
});
