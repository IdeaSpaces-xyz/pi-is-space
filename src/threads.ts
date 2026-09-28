import { relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { parseFrontmatter, summarizeMarkdown } from "@ideaspaces/protocol";

export type ThreadRequest = {
  action: "list" | "open" | "post" | "close";
  path?: string;
  depth?: "name" | "summary" | "full";
  message?: string;
  reply_to?: string[];
  author?: string;
  name?: string;
  summary?: string;
  map?: string;
  pin?: string;
  position?: string;
};

/** Construct only the local CLI verbs; never infer an authored pin from HEAD. */
export function threadArgs(input: ThreadRequest): string[] {
  const { action, path } = input;
  if (action === "list") {
    if (path?.startsWith("x_")) throw new Error("is_threads is local-only; use a directory, not a hosted x_ id.");
    return ["threads", "list", path || ".", "--depth", input.depth ?? "summary"];
  }
  if (!path?.trim() || /^x_[0-9a-f]+$/.test(path.trim())) {
    throw new Error("Provide a local Thread path, not a hosted x_ id.");
  }
  if (action === "open") {
    if (input.pin && !input.position || input.position && !input.pin) throw new Error("Pinned open requires both authored pin and position; never substitute HEAD.");
    if (input.map) throw new Error("Opening a pinned member needs an authored pin and position; map is for posting.");
    return ["threads", "open", path, "--depth", input.pin ? "full" : input.depth ?? "summary",
      ...(input.pin ? ["--pin", input.pin, "--position", input.position!] : [])];
  }
  if (input.pin || input.position || input.depth) throw new Error("Pin, position and depth apply to opening, not writing.");
  if (!input.message?.trim()) throw new Error("A post or closure needs a nonempty message.");
  if (action === "close" && input.reply_to?.length) throw new Error("Closure parent is chosen by the CLI; omit reply_to.");
  return ["threads", action, path, "--message", input.message,
    ...(input.author ? ["--author", input.author] : []),
    ...(action === "post" ? [
      ...(input.reply_to?.length ? ["--reply-to", input.reply_to.join(",")] : []),
      ...(input.name ? ["--name", input.name] : []),
      ...(input.summary ? ["--summary", input.summary] : []),
      ...(input.map ? ["--map", input.map] : []),
    ] : [])];
}

/** A post lives under the named extension, never under ordinary Content. */
export function pinnedView(data: { pinned?: string; pin?: string; position?: string }, depth: "name" | "summary" | "full"): string {
  if (!data.pinned || !data.pin || !data.position) throw new Error("CLI did not return the authored pinned member; refusing working-tree fallback.");
  const text = data.pinned;
  const name = typeof parseFrontmatter(text)?.name === "string" ? parseFrontmatter(text)!.name as string : data.position.split("/").at(-1)!.replace(/\.md$/, "");
  return depth === "name" ? name : depth === "summary" ? `${name}\n${summarizeMarkdown(text) ?? ""}` : text;
}

export function threadPost(path: string, root: string): { thread: string; position: string } | null {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(resolve(root, path));
  } catch {
    return null; // Let the ordinary look report the missing path.
  }
  const rel = relative(realRoot, realTarget).split(sep).join("/");
  const match = /^_threads\/([^/]+)\/([^/]+\.md)$/.exec(rel);
  if (!match || match[2] === "README.md") return null;
  return { thread: resolve(realRoot, "_threads", match[1]), position: rel };
}
