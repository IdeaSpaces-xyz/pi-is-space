import { cliOption } from "./catalog-adapter.js";
import { relative, resolve, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  THREAD_KINDS,
  parseFrontmatter,
  parseMap,
  stripFrontmatter,
  summarizeMarkdown,
} from "@ideaspaces/protocol";
import { parse as parseYaml } from "yaml";

export type ThreadRequest = {
  action: "list" | "new" | "open" | "post" | "close";
  path?: string;
  hosted?: boolean;
  unread?: boolean;
  cursor?: string;
  recipients?: string[];
  post_id?: string;
  depth?: "name" | "summary" | "children" | "surface" | "full";
  since?: string;
  new?: boolean;
  post?: string;
  limit?: number;
  order?: "newer" | "older";
  message?: string;
  kind?: string;
  mark?: string;
  supersedes?: string;
  reply_to?: string[];
  tags?: string[];
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
  if ((input.action as string) === "ack")
    throw new Error(
      "Agent acknowledgement is held until a separate agent token exists; it must not move the person's Unread.",
    );
  if (input.hosted || /^x_[0-9a-f]+$/.test(input.path?.trim() ?? ""))
    return hostedArgs(input);
  if (
    input.cursor !== undefined ||
    input.recipients !== undefined ||
    input.post_id !== undefined ||
    input.unread !== undefined
  )
    throw new Error("Hosted options require hosted: true or an x_ id.");
  if (input.action === "new")
    throw new Error(
      "Pi new requires hosted: true; use the CLI for local Thread creation.",
    );
  const { action, path } = input;
  const selected = input.member !== undefined || input.checkout !== undefined;
  if (
    (input.kind !== undefined ||
      input.mark !== undefined ||
      input.supersedes !== undefined) &&
    action !== "post"
  )
    throw new Error("kind, mark and supersedes apply only to local posts.");
  if (input.tags?.length && action !== "post")
    throw new Error("tags apply only to local posts.");
  if (input.reply_to?.length && action !== "post")
    throw new Error("reply_to applies only to posts.");
  if (
    selected &&
    ((action !== "open" && action !== "post") ||
      !input.map ||
      input.member === undefined ||
      !Number.isSafeInteger(input.member) ||
      input.member < 0)
  ) {
    throw new Error(
      "Selected Thread requires map and a zero-based member for open or post.",
    );
  }
  if (input.map && action === "open" && !selected)
    throw new Error("Pinned Map open requires a member; never infer HEAD.");
  if (action === "list") {
    if (input.map || selected)
      throw new Error("Selection applies only to open or post.");
    if (input.limit !== undefined)
      throw new Error(
        "List paging requires hosted: true; local list does not accept limit.",
      );
    if (input.since || input.post || input.new)
      throw new Error(
        "--since, --new and --post select an opened Thread, not a list.",
      );
    return [
      "threads",
      "list",
      ...(path ? [path] : []),
      cliOption("--depth", input.depth ?? "summary"),
    ];
  }
  if (!path?.trim())
    throw new Error("Provide a local Thread path or hosted x_ id.");
  if (input.new && input.since)
    throw new Error("Use --new or --since, not both.");
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 1)
  )
    throw new Error("limit must be a positive integer.");
  if (
    input.order !== undefined &&
    input.order !== "newer" &&
    input.order !== "older"
  )
    throw new Error("order must be newer or older.");
  if (
    (input.limit !== undefined || input.order !== undefined) &&
    action !== "open"
  )
    throw new Error("limit and order apply to opening, not writing.");
  if (action === "open") {
    if (input.post && (input.limit !== undefined || input.order !== undefined))
      throw new Error("One exact post needs no limit or order.");
    if (
      (selected || input.pin) &&
      (input.limit !== undefined || input.order !== undefined)
    )
      throw new Error("Pinned selection needs no limit or order.");
    if (
      (selected || input.pin) &&
      (input.new || input.since || input.post || input.depth === "children")
    )
      throw new Error(
        "An authored pinned post cannot use --new, --since, --post or children; open the live Thread to traverse it.",
      );
    if ((input.pin && !input.position) || (input.position && !input.pin))
      throw new Error(
        "Pinned open requires both authored pin and position; never substitute HEAD.",
      );
    if (selected && (input.pin || input.position))
      throw new Error(
        "Use either selected Map member or explicit pin and position, not both.",
      );
    return [
      "threads",
      "open",
      path,
      cliOption(
        "--depth",
        input.pin || selected ? "full" : (input.depth ?? "surface"),
      ),
      ...(input.new ? ["--new"] : []),
      ...(input.since ? [cliOption("--since", input.since)] : []),
      ...(input.post ? [cliOption("--post", input.post)] : []),
      ...(input.limit ? [cliOption("--limit", String(input.limit))] : []),
      ...(input.order ? [cliOption("--order", input.order)] : []),
      ...(input.pin
        ? [
            cliOption("--pin", input.pin),
            cliOption("--position", input.position!),
          ]
        : []),
      ...(selected ? selectionArgs(input) : []),
    ];
  }
  if (
    input.pin ||
    input.position ||
    input.depth ||
    input.new ||
    input.since ||
    input.post
  )
    throw new Error(
      "Pin, position, depth, --new, --since and --post apply to opening, not writing.",
    );
  if (input.tags?.some((tag) => !tag?.trim() || tag.includes(",")))
    throw new Error("tags must be non-empty and may not contain commas.");
  if (selected && (input.author || !input.reply_to?.length))
    throw new Error(
      "Selected post requires an explicit parent and the caller's Agreement author; omit author.",
    );
  if (!input.message?.trim())
    throw new Error("A post or closure needs a nonempty message.");
  if (action === "post" && input.kind !== undefined && !input.kind.trim())
    throw new Error("kind must be a non-empty string.");
  if (
    action === "post" &&
    input.kind &&
    !THREAD_KINDS.includes(input.kind as (typeof THREAD_KINDS)[number])
  ) {
    throw new Error(
      `kind ${JSON.stringify(input.kind)} is not a kind: use ${THREAD_KINDS.join(", ")}. A label for a post goes in tags.`,
    );
  }
  if (
    action === "post" &&
    input.kind === "mark" &&
    (!input.mark?.trim() ||
      input.reply_to?.length !== 1 ||
      input.reply_to[0] === "latest")
  ) {
    throw new Error(
      "kind: mark requires mark and reply_to with exactly one explicit target post id.",
    );
  }
  if (input.mark !== undefined && input.kind !== "mark")
    throw new Error("mark requires kind: mark.");
  if (input.kind === "correction" && !input.supersedes?.trim())
    throw new Error(
      "kind: correction requires supersedes with the post id being corrected or retracted.",
    );
  if (input.supersedes !== undefined && input.kind !== "correction")
    throw new Error("supersedes requires kind: correction.");
  if (
    action === "close" &&
    (input.reply_to?.length ||
      input.name ||
      input.summary ||
      input.map ||
      input.tags?.length)
  )
    throw new Error(
      "Closure only accepts message and author; omit reply_to, name, summary, tags and map.",
    );
  return [
    "threads",
    action,
    path,
    cliOption("--message", input.message),
    ...(input.author ? [cliOption("--author", input.author)] : []),
    ...(action === "post"
      ? [
          ...(input.reply_to?.length
            ? [cliOption("--reply-to", input.reply_to.join(","))]
            : []),
          ...(input.kind ? [cliOption("--kind", input.kind)] : []),
          ...(input.mark ? [cliOption("--mark", input.mark)] : []),
          ...(input.supersedes
            ? [cliOption("--supersedes", input.supersedes)]
            : []),
          ...(input.name ? [cliOption("--name", input.name)] : []),
          ...(input.summary ? [cliOption("--summary", input.summary)] : []),
          ...(input.tags?.length
            ? [cliOption("--tags", input.tags.join(","))]
            : []),
          ...(selected
            ? selectionArgs(input)
            : input.map
              ? [cliOption("--map", input.map)]
              : []),
        ]
      : []),
  ];
}

function selectionArgs(input: ThreadRequest): string[] {
  return [
    cliOption("--map", input.map!),
    cliOption("--member", String(input.member)),
    ...(input.checkout ? [cliOption("--checkout", input.checkout)] : []),
  ];
}

/** Independently check CLI's returned coordinate against authored bytes, not its own echo.
 * Protocol parses Map shape but has no file/inline Map reader; mirror CLI input
 * resolution here, leaving checkout identity and all write checks to the CLI. */
export function authoredMember(
  mapInput: string,
  ordinal: number,
  cwd = process.cwd(),
): { pin: string; position: string } {
  const path = resolve(cwd, mapInput);
  let value: unknown;
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024)
        throw new Error("Map must be a regular file no larger than 128 KiB.");
      const text = readFileSync(path, "utf8");
      value = parseFrontmatter(text)?.map ?? parseYaml(text);
    } else {
      value = parseYaml(mapInput);
    }
  } catch (error) {
    throw new Error(
      `Cannot read authored Map: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (value && typeof value === "object" && "map" in value)
    value = (value as { map: unknown }).map;
  const parsed = parseMap(value);
  if (parsed.status === "absent")
    throw new Error("Authored Map has no roots or members.");
  if (parsed.status === "invalid")
    throw new Error(
      `Invalid authored Map: ${parsed.issues.map((issue) => `${issue.path}: ${issue.code}`).join(", ")}`,
    );
  const member = parsed.map.members[ordinal];
  if (!member) throw new Error(`Authored Map has no member ${ordinal}.`);
  if (
    !("position" in member) ||
    typeof member.position !== "string" ||
    typeof member.root !== "number"
  )
    throw new Error(`Map member ${ordinal} is not a pinned position.`);
  const pin = parsed.map.roots[member.root]?.sha;
  if (!pin) throw new Error("Selected Map root has no authored commit pin.");
  return { pin, position: member.position };
}

/** A post lives under the named extension, never under ordinary Content. */
export function postView(
  text: string,
  position: string,
  depth: "name" | "summary" | "surface" | "full",
): string {
  const fm = parseFrontmatter(text);
  const name =
    typeof fm?.name === "string"
      ? fm.name
      : position.split("/").at(-1)!.replace(/\.md$/, "");
  return depth === "name"
    ? name
    : depth === "summary"
      ? `${name}\n${summarizeMarkdown(text) ?? ""}`
      : depth === "surface"
        ? stripFrontmatter(text)
        : text;
}

export function pinnedView(
  data: { pinned?: string; pin?: string; position?: string },
  depth: "name" | "summary" | "surface" | "full",
  expected: { pin: string; position: string },
): string {
  if (
    !data.pinned ||
    data.pin !== expected.pin ||
    data.position !== expected.position
  ) {
    throw new Error(
      "CLI did not return the requested authored pin and position; refusing working-tree fallback.",
    );
  }
  return postView(data.pinned, expected.position, depth);
}

export function threadPost(
  path: string,
  root: string,
): { thread: string; position: string } | null {
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

/** Hosted requests use only the /threads CLI contract; local pin flags never leak across. */
function hostedArgs(input: ThreadRequest): string[] {
  const action = input.action;
  const path = input.path?.trim();
  const allowed: Record<string, string[]> = {
    list: ["hosted", "limit", "cursor", "unread"],
    new: [
      "hosted",
      "name",
      "summary",
      "message",
      "recipients",
      "map",
      "post_id",
    ],
    open: ["hosted", "path", "limit", "cursor"],
    post: [
      "hosted",
      "path",
      "reply_to",
      "message",
      "name",
      "summary",
      "map",
      "post_id",
    ],
  };
  if (!allowed[action])
    throw new Error(
      "Hosted close requires an explicit CLI preview and confirmation; use threads close x_id --message <why> then --yes.",
    );
  for (const [key, value] of Object.entries(input)) {
    if (
      key !== "action" &&
      key !== "cwd" &&
      value !== undefined &&
      !(Array.isArray(value) && value.length === 0) &&
      !allowed[action].includes(key)
    )
      throw new Error(
        `${key} is local-only or unsupported for hosted ${action}; omit it.`,
      );
  }
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)
  )
    throw new Error("Hosted limit must be from 1 to 200.");
  if (action === "list" || action === "new") {
    if (path)
      throw new Error("Hosted list/new takes no path; use hosted: true.");
  } else if (!/^x_(?:[0-9a-f]{24}|[0-9a-f]{32})$/.test(path ?? ""))
    throw new Error(
      "Hosted Thread id must be x_ followed by 24 or 32 hex digits.",
    );
  if (input.recipients?.some((r) => !r.trim() || r.includes(",")))
    throw new Error(
      "Each recipients entry must be one selector, not a comma-separated list.",
    );
  if (
    input.post_id !== undefined &&
    !/^msg_[A-Za-z0-9_-]{1,60}$/.test(input.post_id)
  )
    throw new Error("post_id must be a msg_ id.");
  if (action === "new" && (!input.name?.trim() || !input.summary?.trim()))
    throw new Error("Hosted new requires name and summary.");
  if ((action === "new" || action === "post") && !input.message?.trim())
    throw new Error("Hosted writes require message.");
  if (
    action === "post" &&
    (!input.reply_to?.length ||
      input.reply_to.length > 16 ||
      new Set(input.reply_to).size !== input.reply_to.length ||
      input.reply_to.some((p) => !/^msg_[A-Za-z0-9_-]{1,60}$/.test(p)))
  )
    throw new Error(
      "Hosted reply_to requires one to 16 distinct msg_ parent ids. Old n_ ids are not converted.",
    );
  return [
    "threads",
    action,
    ...(action === "list" || action === "new" ? ["--hosted"] : [path!]),
    ...(input.limit !== undefined
      ? [cliOption("--limit", String(input.limit))]
      : []),
    ...(input.cursor !== undefined
      ? [cliOption("--cursor", input.cursor)]
      : []),
    ...(input.unread ? ["--unread"] : []),
    ...(input.reply_to
      ? [cliOption("--reply-to", input.reply_to.join(","))]
      : []),
    ...(input.message !== undefined
      ? [cliOption("--message", input.message)]
      : []),
    ...(input.name !== undefined ? [cliOption("--name", input.name)] : []),
    ...(input.summary !== undefined
      ? [cliOption("--summary", input.summary)]
      : []),
    ...(input.recipients !== undefined
      ? [cliOption("--recipients", input.recipients.join(","))]
      : []),
    ...(input.map !== undefined ? [cliOption("--map", input.map)] : []),
    ...(input.post_id !== undefined
      ? [cliOption("--post-id", input.post_id)]
      : []),
  ];
}

/** A stale CLI must never silently route a ported id back into /exchanges. */
export function threadsOnlyCapability(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    c.schema === "ideaspaces.threads.capabilities.v1" &&
    c.transport === "/threads" &&
    c.legacy_exchange_fallback === false
  );
}
export function needsHostedThreads(input: ThreadRequest): boolean {
  return (
    !!input.hosted ||
    /^x_[0-9a-f]+$/.test(input.path?.trim() ?? "") ||
    (input.action === "list" && !input.path?.trim())
  );
}

export function lookReaderArgs(input: {
  limit?: number;
  since?: string;
  order?: "older" | "newer";
  post?: string;
}): string[] {
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 0)
  )
    throw new Error("limit must be a non-negative integer.");
  if (input.since !== undefined && !input.since.trim())
    throw new Error("since needs a child filename from nextCursor.");
  if (input.post !== undefined && !input.post.trim())
    throw new Error("post needs a msg_ id.");
  if (input.post && (input.limit !== undefined || input.since || input.order))
    throw new Error("post selects one id; omit limit, since and order.");
  return [
    ...(input.limit !== undefined
      ? [cliOption("--limit", String(input.limit))]
      : []),
    ...(input.since ? [cliOption("--since", input.since)] : []),
    ...(input.order ? [cliOption("--order", input.order)] : []),
    ...(input.post ? [cliOption("--post", input.post)] : []),
  ];
}
