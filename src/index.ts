import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

type CliResult = { out: string; err: string; code: number };

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function isErrorResult(result: any): boolean {
  return result?.isError === true;
}

function resultText(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

function parseJson<T = any>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function resolveCli(): string {
  if (process.env.IS_CLI_PATH) return process.env.IS_CLI_PATH;

  const require = createRequire(import.meta.url);
  try {
    const mainPath = require.resolve("@ideaspaces/cli");
    const bundled = resolvePath(dirname(mainPath), "../bundle/ideaspaces.js");
    if (existsSync(bundled)) return bundled;
  } catch {
    // fall through
  }

  // fallback for monorepo local dev
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const local = resolvePath(__dirname, "../../cli/bundle/ideaspaces.js");
  if (existsSync(local)) return local;

  // final fallback: rely on ideaspaces being available on PATH
  return "ideaspaces";
}

const CLI = resolveCli();

function cli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const isFile =
      CLI.includes("/") || CLI.includes("\\") || CLI.endsWith(".js");

    const proc = spawn(isFile ? "node" : CLI, isFile ? [CLI, ...args] : args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ out, err, code: code ?? 1 }));
    proc.on("error", (e) => resolve({ out: "", err: e.message, code: 1 }));

    if (stdin != null) proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

async function run(args: string[], stdin?: string) {
  const { out, err, code } = await cli(["--json", ...args], stdin);
  if (code !== 0) return fail(err.trim() || out.trim() || `Exit ${code}`);
  return ok(out.trim() || err.trim() || "Done");
}

async function runRepo(args: string[]) {
  const result = await run(["power", "repo", ...args]);
  if (!isErrorResult(result)) return result;

  const text = resultText(result);
  if (text.includes("Unknown command: repo") || text.includes("cannot call sync")) {
    return fail(
      "This CLI build does not support repo sync commands yet. Update @ideaspaces/cli to a newer version.",
    );
  }

  return result;
}

export default function (pi: ExtensionAPI) {
  let cachedAwareness: string | null = null;

  async function resolveSpaceDisplay(repoId?: string): Promise<string> {
    if (!repoId) return "connected";

    const repos = await cli(["--json", "power", "repos"]);
    if (repos.code !== 0) return repoId;

    const parsed = parseJson<any>(repos.out);
    const match = parsed?.repos?.find((r: any) => r.repo_id === repoId);
    if (!match) return repoId;

    const name = typeof match.name === "string" ? match.name.trim() : "";
    const slug = typeof match.slug === "string" ? match.slug.trim() : "";

    if (name && slug && name.toLowerCase() !== slug.toLowerCase()) {
      return `${name}/${slug}`;
    }

    return name || slug || repoId;
  }

  async function refreshAwareness(): Promise<void> {
    const awareness = await cli(["--json", "awareness"]);
    if (awareness.code !== 0) {
      cachedAwareness = null;
      return;
    }
    const aw = parseJson<any>(awareness.out);
    cachedAwareness = aw?.awareness ? String(aw.awareness) : null;
  }

  async function ensureAwareness(): Promise<void> {
    if (cachedAwareness !== null) return;

    const status = await cli(["--json", "power", "status"]);
    if (status.code !== 0) return;

    const parsed = parseJson<any>(status.out);
    if (!parsed?.connected) return;

    await refreshAwareness();
  }

  pi.on("session_start", async (_event, ctx) => {
    const status = await cli(["--json", "power", "status"]);
    if (status.code !== 0) {
      cachedAwareness = null;
      ctx.ui.setStatus("is", "📚 disconnected");
      return;
    }

    const parsed = parseJson<any>(status.out);
    if (!parsed?.connected) {
      cachedAwareness = null;
      ctx.ui.setStatus("is", "📚 / is_auth");
      return;
    }

    const display = await resolveSpaceDisplay(parsed.repo);
    ctx.ui.setStatus("is", `📚 ${display}`);

    await refreshAwareness();
  });

  pi.on("before_agent_start", async (event) => {
    await ensureAwareness();
    if (!cachedAwareness) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n[IdeaSpaces Awareness]\n${cachedAwareness}`,
    };
  });

  pi.registerTool({
    name: "is_auth",
    label: "IS Auth",
    description: "Connect to a space, create a new space, inspect repo sync state, and manage credentials. Spaces are either personal (no hostname) or belong to an organization (hostname like 'ideaspaces.xyz'). Use repos to see both scopes. Use hostname/slug to login to org spaces.",
    promptSnippet: "Connect and manage IdeaSpaces authentication",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([
          Type.Literal("login"),
          Type.Literal("logout"),
          Type.Literal("repos"),
          Type.Literal("status"),
          Type.Literal("create"),
          Type.Literal("repo_status"),
          Type.Literal("repo_pull"),
          Type.Literal("repo_push"),
          Type.Literal("repo_credential_set"),
          Type.Literal("repo_credential_clear"),
        ])
      ),
      repo: Type.Optional(Type.String({ description: "Space slug or hostname/slug to connect to (e.g. 'notes' or 'ideaspaces.xyz/notes')" })),
      name: Type.Optional(Type.String({ description: "Space name (for create)" })),
      purpose: Type.Optional(Type.String({ description: "Space purpose (for create)" })),
      hostname: Type.Optional(Type.String({ description: "Organization hostname for team spaces (for create). Omit for personal space." })),
      value: Type.Optional(Type.String({ description: "Credential value (for repo_credential_set)" })),
    }),
    async execute(_id, params) {
      const action = params.action ?? "login";
      switch (action) {
        case "login": {
          const result = await run(params.repo ? ["login", params.repo] : ["login"]);
          if (!isErrorResult(result)) await refreshAwareness();
          return result;
        }
        case "logout":
          cachedAwareness = null;
          return run(["power", "logout"]);
        case "repos":
          return run(["power", "repos"]);
        case "status":
          return run(["power", "status"]);
        case "create": {
          if (!params.name) return fail("name required for create");
          const args = ["power", "create", params.name];
          if (params.purpose) args.push("--purpose", params.purpose);
          if (params.repo) args.push("--slug", params.repo);
          if (params.hostname) args.push("--hostname", params.hostname);
          const result = await run(args);
          if (!isErrorResult(result)) await refreshAwareness();
          return result;
        }
        case "repo_status":
          return runRepo(["status"]);
        case "repo_pull": {
          const result = await runRepo(["pull"]);
          if (!isErrorResult(result)) await refreshAwareness();
          return result;
        }
        case "repo_push": {
          const result = await runRepo(["push"]);
          if (!isErrorResult(result)) await refreshAwareness();
          return result;
        }
        case "repo_credential_set": {
          if (!params.value) return fail("value required for repo_credential_set");
          return runRepo(["credential", "set", "--value", params.value]);
        }
        case "repo_credential_clear":
          return runRepo(["credential", "clear"]);
      }
    },
  });

  pi.registerTool({
    name: "is_explore",
    label: "IS Explore",
    description:
      "See what's in the space. Returns tree structure, README context, and what changed since last session.",
    promptSnippet: "Explore the knowledge space",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path. Empty for root." })),
      full: Type.Optional(
        Type.Boolean({ description: "Return full outline of every file and directory." })
      ),
    }),
    async execute(_id, params) {
      if (params.full) return run(["power", "outline"]);
      return run(params.path ? ["navigate", params.path] : ["navigate"]);
    },
  });

  pi.registerTool({
    name: "is_find",
    label: "IS Find",
    description:
      "Find knowledge by meaning, text pattern, or metadata. Automatically picks the right search method.",
    promptSnippet: "Find knowledge by meaning, text, or metadata",
    parameters: Type.Object({
      method: Type.Optional(
        Type.Union([
          Type.Literal("search"),
          Type.Literal("grep"),
          Type.Literal("list"),
        ])
      ),
      query: Type.Optional(Type.String({ description: "Search query or grep pattern" })),
      scope: Type.Optional(Type.String({ description: "Directory scope" })),
      type: Type.Optional(
        Type.String({ description: "Node type: note, perspective, skill, agent_context" })
      ),
      tag: Type.Optional(Type.String({ description: "Tag filter (list mode)" })),
      attached_to: Type.Optional(Type.String({ description: "Entity filter" })),
      contributed_by: Type.Optional(Type.String({ description: "Author filter" })),
      heading: Type.Optional(Type.String({ description: "Extract section by heading (grep)" })),
      tags: Type.Optional(Type.String({ description: "Tags filter (search)" })),
      limit: Type.Optional(Type.Number({ description: "Max results" })),
    }),
    async execute(_id, params) {
      const method = params.method ?? "search";
      const args: string[] = [];

      switch (method) {
        case "search":
          if (!params.query) return fail("query required for search");
          args.push("search", params.query);
          if (params.scope) args.push("--scope", params.scope);
          if (params.type) args.push("--type", params.type);
          if (params.attached_to) args.push("--attached-to", params.attached_to);
          if (params.contributed_by) args.push("--contributed-by", params.contributed_by);
          if (params.tags) args.push("--tags", params.tags);
          if (typeof params.limit === "number") args.push("--limit", String(params.limit));
          break;

        case "grep":
          args.push("power", "grep");
          if (params.query) args.push(params.query);
          if (params.scope) args.push("--scope", params.scope);
          if (params.heading) args.push("--heading", params.heading);
          break;

        case "list":
          args.push("power", "find");
          if (params.tag) args.push("--tag", params.tag);
          if (params.type) args.push("--type", params.type);
          if (params.attached_to) args.push("--attached-to", params.attached_to);
          if (params.contributed_by) args.push("--contributed-by", params.contributed_by);
          if (params.scope) args.push("--dir", params.scope);
          if (typeof params.limit === "number") args.push("--limit", String(params.limit));
          break;
      }

      return run(args);
    },
  });

  pi.registerTool({
    name: "is_read",
    label: "IS Read",
    description: "Read a note's content and metadata. Add history=true to see how it evolved.",
    promptSnippet: "Read note content + metadata",
    parameters: Type.Object({
      path: Type.String({
        description: "File path or node ID (e.g. core/About.md or n_b4d942f682a0)",
      }),
      offset: Type.Optional(Type.Number({ description: "Start line (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Max lines" })),
      history: Type.Optional(Type.Boolean({ description: "Include git log for this file" })),
    }),
    async execute(_id, params) {
      const args = ["read", params.path];
      if (typeof params.offset === "number") args.push("--offset", String(params.offset));
      if (typeof params.limit === "number") args.push("--limit", String(params.limit));

      const result = await run(args);
      if (result.isError || !params.history) return result;

      const hist = await cli(["--json", "power", "git", "log", "--path", params.path]);
      if (hist.code === 0 && hist.out.trim()) {
        return ok(`${result.content[0].text}\n\n--- History ---\n${hist.out.trim()}`);
      }

      return result;
    },
  });

  pi.registerTool({
    name: "is_write",
    label: "IS Write",
    description:
      "Create, update, move, or delete notes. Specify action: write, update_metadata, move, or delete.",
    promptSnippet: "Create/update/move/delete notes",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([
          Type.Literal("write"),
          Type.Literal("update_metadata"),
          Type.Literal("move"),
          Type.Literal("delete"),
        ])
      ),
      path: Type.Optional(Type.String({ description: "File path (write, delete)" })),
      content: Type.Optional(Type.String({ description: "Markdown content (write)" })),
      name: Type.Optional(Type.String({ description: "Note name" })),
      summary: Type.Optional(Type.String({ description: "Dense summary for search" })),
      tags: Type.Optional(Type.Array(Type.String())),
      attached_to: Type.Optional(Type.Array(Type.String({ description: "Entity binding" }))),
      if_match: Type.Optional(Type.String({ description: "SHA from is_read" })),
      node_id: Type.Optional(Type.String({ description: "Node ID (update_metadata)" })),
      accessibility: Type.Optional(Type.Array(Type.String())),
      references: Type.Optional(Type.Array(Type.String())),
      source: Type.Optional(Type.String({ description: "Current path (move)" })),
      destination: Type.Optional(Type.String({ description: "New path (move)" })),
    }),
    async execute(_id, params) {
      const action = params.action ?? "write";

      switch (action) {
        case "write": {
          if (!params.path) return fail("path required");
          if (!params.content) return fail("content required");
          const args = ["write", params.path];
          if (params.name) args.push("--name", params.name);
          if (params.summary) args.push("--summary", params.summary);
          if (params.tags?.length) args.push("--tags", params.tags.join(","));
          if (params.attached_to?.length) args.push("--attached-to", params.attached_to.join(","));
          if (params.if_match) args.push("--if-match", params.if_match);
          const result = await run(args, params.content);
          if (!isErrorResult(result)) cachedAwareness = null;
          return result;
        }

        case "update_metadata": {
          if (!params.node_id) return fail("node_id required");
          const args = ["power", "metadata", params.node_id];
          if (params.tags?.length) args.push("--tags", params.tags.join(","));
          if (params.attached_to?.length) args.push("--attached-to", params.attached_to.join(","));
          if (params.accessibility?.length)
            args.push("--accessibility", params.accessibility.join(","));
          if (params.references?.length) args.push("--references", params.references.join(","));
          const result = await run(args);
          if (!isErrorResult(result)) cachedAwareness = null;
          return result;
        }

        case "move": {
          if (!params.source || !params.destination)
            return fail("source and destination required");
          const result = await run(["power", "move", params.source, params.destination]);
          if (!isErrorResult(result)) cachedAwareness = null;
          return result;
        }

        case "delete": {
          if (!params.path) return fail("path required");
          const result = await run(["power", "delete", params.path, "--yes"]);
          if (!isErrorResult(result)) cachedAwareness = null;
          return result;
        }
      }
    },
  });
}
