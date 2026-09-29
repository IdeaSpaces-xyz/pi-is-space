import { relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { parseFrontmatter, parseMap, stripFrontmatter, summarizeMarkdown } from "@ideaspaces/protocol";
import { parse as parseYaml } from "yaml";

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
  member?: number;
  checkout?: string;
  pin?: string;
  position?: string;
};

/** Construct only the local CLI verbs; never infer an authored pin from HEAD. */
export function threadArgs(input: ThreadRequest): string[] {
  const { action, path } = input;
  const selected = input.member !== undefined || input.checkout !== undefined;
  if (selected && (action !== "open" && action !== "post" || !input.map || input.member === undefined || !Number.isSafeInteger(input.member) || input.member < 0)) {
    throw new Error("Selected Thread requires map and a zero-based member for open or post.");
  }
  if (input.map && action === "open" && !selected) throw new Error("Pinned Map open requires a member; never infer HEAD.");
  if (action === "list") {
    if (input.map || selected) throw new Error("Selection applies only to open or post.");
    if (path?.startsWith("x_")) throw new Error("is_threads is local-only; use a directory, not a hosted x_ id.");
    return ["threads", "list", path || ".", "--depth", input.depth ?? "summary"];
  }
  if (!path?.trim() || path.trim().startsWith("x_")) {
    throw new Error("Provide a local Thread path, not a hosted x_ id.");
  }
  if (action === "open") {
    if (input.pin && !input.position || input.position && !input.pin) throw new Error("Pinned open requires both authored pin and position; never substitute HEAD.");
    if (selected && (input.pin || input.position)) throw new Error("Use either selected Map member or explicit pin and position, not both.");
    return ["threads", "open", path, "--depth", input.pin || selected ? "full" : input.depth ?? "summary",
      ...(input.pin ? ["--pin", input.pin, "--position", input.position!] : []),
      ...(selected ? selectionArgs(input) : [])];
  }
  if (input.pin || input.position || input.depth) throw new Error("Pin, position and depth apply to opening, not writing.");
  if (selected && (input.author || !input.reply_to?.length)) throw new Error("Selected post requires an explicit parent and the caller's Agreement author; omit author.");
  if (!input.message?.trim()) throw new Error("A post or closure needs a nonempty message.");
  if (action === "close" && (input.reply_to?.length || input.name || input.summary || input.map)) throw new Error("Closure only accepts message and author; omit reply_to, name, summary and map.");
  return ["threads", action, path, "--message", input.message,
    ...(input.author ? ["--author", input.author] : []),
    ...(action === "post" ? [
      ...(input.reply_to?.length ? ["--reply-to", input.reply_to.join(",")] : []),
      ...(input.name ? ["--name", input.name] : []),
      ...(input.summary ? ["--summary", input.summary] : []),
      ...(selected ? selectionArgs(input) : input.map ? ["--map", input.map] : []),
    ] : [])];
}

function selectionArgs(input: ThreadRequest): string[] {
  return ["--map", input.map!, "--member", String(input.member), ...(input.checkout ? ["--checkout", input.checkout] : [])];
}

/** Independently check CLI's returned coordinate against authored bytes, not its own echo.
 * Protocol parses Map shape but has no file/inline Map reader; mirror CLI input
 * resolution here, leaving checkout identity and all write checks to the CLI. */
export function authoredMember(mapInput: string, ordinal: number, cwd = process.cwd()): { pin: string; position: string } {
  const path = resolve(cwd, mapInput);
  let value: unknown;
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Map must be a regular file no larger than 128 KiB.");
      const text = readFileSync(path, "utf8");
      value = parseFrontmatter(text)?.map ?? parseYaml(text);
    } else {
      value = parseYaml(mapInput);
    }
  } catch (error) {
    throw new Error(`Cannot read authored Map: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value && typeof value === "object" && "map" in value) value = (value as { map: unknown }).map;
  const parsed = parseMap(value);
  if (parsed.status === "absent") throw new Error("Authored Map has no roots or members.");
  if (parsed.status === "invalid") throw new Error(`Invalid authored Map: ${parsed.issues.map((issue) => `${issue.path}: ${issue.code}`).join(", ")}`);
  const member = parsed.map.members[ordinal];
  if (!member) throw new Error(`Authored Map has no member ${ordinal}.`);
  if (!("position" in member) || typeof member.position !== "string" || typeof member.root !== "number") throw new Error(`Map member ${ordinal} is not a pinned position.`);
  const pin = parsed.map.roots[member.root]?.sha;
  if (!pin) throw new Error("Selected Map root has no authored commit pin.");
  return { pin, position: member.position };
}

/** A post lives under the named extension, never under ordinary Content. */
export function postView(text: string, position: string, depth: "name" | "summary" | "surface" | "full"): string {
  const fm = parseFrontmatter(text);
  const name = typeof fm?.name === "string" ? fm.name : position.split("/").at(-1)!.replace(/\.md$/, "");
  return depth === "name" ? name : depth === "summary" ? `${name}\n${summarizeMarkdown(text) ?? ""}`
    : depth === "surface" ? stripFrontmatter(text) : text;
}

export function pinnedView(data: { pinned?: string; pin?: string; position?: string }, depth: "name" | "summary" | "surface" | "full", expected: { pin: string; position: string }): string {
  if (!data.pinned || data.pin !== expected.pin || data.position !== expected.position) {
    throw new Error("CLI did not return the requested authored pin and position; refusing working-tree fallback.");
  }
  return postView(data.pinned, expected.position, depth);
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
  // CLI open accepts an absolute Thread directory and verifies it belongs to
  // this Space's _threads/. Use it for mounted roots; a slug would resolve
  // against the caller's home instead of the target Space.
  return { thread: resolve(realRoot, "_threads", match[1]), position: rel };
}
