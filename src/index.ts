import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findSpaceRoot, assembleAwareness } from "@ideaspaces/sdk";

type CliResult = { out: string; err: string; code: number };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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

const AUTOCOMPLETE_LIMIT = 50;
const AUTOCOMPLETE_SCAN_LIMIT = 20_000;
const AUTOCOMPLETE_EXCLUDED_DIRS = new Set([".git", "node_modules"]);

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
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

function scorePath(path: string, query: string, isDirectory: boolean): number {
  if (!query) return isDirectory ? 2 : 1;

  const lowerPath = path.toLowerCase();
  const lowerName = basename(path).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;

  if (lowerName === lowerQuery) score = 100;
  else if (lowerName.startsWith(lowerQuery)) score = 80;
  else if (lowerPath.startsWith(lowerQuery)) score = 70;
  else if (lowerName.includes(lowerQuery)) score = 50;
  else if (lowerPath.includes(lowerQuery)) score = 30;
  else {
    let index = 0;
    for (const char of lowerQuery) {
      index = lowerPath.indexOf(char, index);
      if (index === -1) return 0;
      index += 1;
    }
    score = 10;
  }

  return isDirectory ? score + 5 : score;
}

function formatAutocompleteValue(path: string, isDirectory: boolean, quoted: boolean): string {
  const completionPath = isDirectory ? `${path}/` : path;
  if (!quoted && !completionPath.includes(" ")) return `@${completionPath}`;
  return `@"${completionPath}"`;
}

async function collectFileSuggestions(root: string, query: string, signal: AbortSignal): Promise<FileSuggestion[]> {
  const suggestions: FileSuggestion[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (signal.aborted || scanned >= AUTOCOMPLETE_SCAN_LIMIT) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal.aborted || scanned >= AUTOCOMPLETE_SCAN_LIMIT) return;
      if (entry.isDirectory() && AUTOCOMPLETE_EXCLUDED_DIRS.has(entry.name)) continue;

      const absolutePath = join(dir, entry.name);
      const isSymlink = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      if (isSymlink) {
        try {
          isDirectory = (await stat(absolutePath)).isDirectory();
        } catch {
          continue;
        }
      }

      const relativePath = toPosixPath(relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith("..")) continue;

      scanned += 1;
      const score = scorePath(relativePath, query, isDirectory);
      if (score > 0) suggestions.push({ path: relativePath, isDirectory, score });

      if (isDirectory && !isSymlink) await walk(absolutePath);
    }
  }

  await walk(root);
  return suggestions
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

async function buildAwareness(cwd: string): Promise<{ root: string | null; text: string | null }> {
  const space = await findSpaceRoot(cwd);
  if (space.source === "none" || !space.root) return { root: null, text: null };

  const block = await assembleAwareness({
    root: space.root,
    contract: space.contract,
  });

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

  const parts = [block.trim(), ...drift].filter(Boolean);
  return { root: space.root, text: parts.length ? parts.join("\n\n") : null };
}

export default function (pi: ExtensionAPI) {
  let cachedAwareness: string | null = null;
  let cachedRoot: string | null = null;

  async function refreshAwareness(cwd: string): Promise<void> {
    try {
      const awareness = await buildAwareness(cwd);
      cachedAwareness = awareness.text;
      cachedRoot = awareness.root;
    } catch {
      cachedAwareness = null;
      cachedRoot = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshAwareness(ctx.cwd);
    if (cachedRoot) {
      ctx.ui.setStatus("is", `📚 ${cachedRoot}`);
    } else {
      ctx.ui.setStatus("is", "📚 local-first");
    }

    // IdeaSpaces often uses .gitignore as a sharing boundary, not a local
    // context boundary. Broaden @mention discovery to include gitignored local
    // files while still excluding dependency and git metadata noise.
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
        const mention = extractAtMention(textBeforeCursor);
        if (!mention) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const suggestions = await collectFileSuggestions(ctx.cwd, mention.query, options.signal);
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
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
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
      "Create or update a Note with Layer 1 frontmatter (name, summary). Use for capture; native file tools cover code/config and ordinary edits.",
    promptSnippet: "Create/update a markdown Note with IdeaSpaces frontmatter",
    parameters: Type.Object({
      path: Type.String({ description: "File path within the ideaspace" }),
      content: Type.String({ description: "Markdown content; frontmatter is prepended automatically" }),
      name: Type.Optional(Type.String({ description: "Note name" })),
      summary: Type.Optional(Type.String({ description: "Dense summary for search/orientation" })),
      tags: Type.Optional(Type.Array(Type.String())),
      attached_to: Type.Optional(Type.Array(Type.String({ description: "Entity binding" }))),
      if_match: Type.Optional(Type.String({ description: "Reserved for conditional writes" })),
      force: Type.Optional(Type.Boolean({ description: "Overwrite an existing file" })),
      cwd: Type.Optional(
        Type.String({
          description:
            "Absolute working directory for path resolution. Pass this if the intended cwd differs from the session start directory.",
        }),
      ),
    }),
    async execute(_id, params) {
      const args = ["write", params.path];
      if (params.name) args.push("--name", params.name);
      if (params.summary) args.push("--summary", params.summary);
      if (params.tags?.length) args.push("--tags", params.tags.join(","));
      if (params.attached_to?.length) args.push("--attached-to", params.attached_to.join(","));
      if (params.if_match) args.push("--if-match", params.if_match);
      if (params.force) args.push("--force");

      const result = await run(args, params.content, params.cwd);
      if (!isErrorResult(result)) await refreshAwareness(params.cwd || process.cwd());
      return result;
    },
  });
}
