import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerIdeaSpaces from "./index.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function makeSpace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "is-pi-command-effects-")));
  cleanups.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test Person");
  git(root, "config", "user.email", "person:tester@ideaspaces");
  mkdirSync(join(root, "_agent"));
  writeFileSync(join(root, "_agent/foundation.md"), "# Foundation\n");
  writeFileSync(join(root, "_agent/now.md"), "# Now\n\nTest command effects.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "seed");
  return root;
}

describe("Pi human commit command", () => {
  it("commits the exact reviewed knowledge list in-process and preserves bystanders", async () => {
    const root = makeSpace();
    writeFileSync(join(root, "capture.md"), "# Capture\n");
    writeFileSync(join(root, "source.ts"), "export {};\n");
    git(root, "add", "capture.md", "source.ts");

    const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
    const pi = {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI;
    registerIdeaSpaces(pi);

    const notices: string[] = [];
    const ctx = {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => "sess-command" },
      ui: {
        setStatus() {},
        setWidget() {},
        notify(message: string) {
          notices.push(message);
        },
        async editor() {
          return "Capture reviewed knowledge";
        },
        async confirm() {
          return true;
        },
      },
    } as unknown as ExtensionContext;

    await commands.get("is-commit")!.handler("", ctx);

    expect(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "capture.md",
    );
    expect(git(root, "diff", "--cached", "--name-only")).toBe("source.ts");
    expect(notices.at(-1)).toMatch(/^Committed 1 path\(s\): [0-9a-f]+$/);
  });
});
