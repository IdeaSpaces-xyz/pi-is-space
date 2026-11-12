import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredMember, pinnedView, threadArgs as rawThreadArgs, threadsOnlyCapability, needsHostedThreads, threadPost } from "./threads.js";
const threadArgs = (...args: Parameters<typeof rawThreadArgs>) => rawThreadArgs(...args).flatMap(a => a.startsWith("--") && a.includes("=") ? [a.slice(0,a.indexOf("=")),a.slice(a.indexOf("=")+1)] : [a]);

const pin = "a".repeat(40);
const position = "_threads/trial/post.md";

describe("local Thread CLI adapter", () => {
  it("lists only local rows, opens three rungs without ack, and posts/ closes with author", () => {
    expect(threadArgs({ action: "list" })).toEqual(["threads", "list", "--depth", "summary"]);
    for (const depth of ["name", "summary", "full"] as const) {
      expect(threadArgs({ action: "open", path: "trial", depth })).toEqual(["threads", "open", "trial", "--depth", depth]);
    }
    expect(threadArgs({ action: "post", path: "trial", message: "Decision", author: "Pi", reply_to: ["msg_1"], map: "selection.yaml" }))
      .toEqual(["threads", "post", "trial", "--message", "Decision", "--author", "Pi", "--reply-to", "msg_1", "--map", "selection.yaml"]);
    expect(threadArgs({ action: "close", path: "trial", message: "Done", author: "Claude" }))
      .toEqual(["threads", "close", "trial", "--message", "Done", "--author", "Claude"]);
  });
  it("forwards only complete selected coordinates and retains the caller's author boundary", () => {
    const selected = { map: "selection.yaml", member: 0, checkout: "/trusted/home" };
    expect(threadArgs({ action: "open", path: "trial", depth: "summary", ...selected }))
      .toEqual(["threads", "open", "trial", "--depth", "full", "--map", "selection.yaml", "--member", "0", "--checkout", "/trusted/home"]);
    expect(threadArgs({ action: "post", path: "trial", message: "Reply", reply_to: ["msg_seed"], ...selected }))
      .toEqual(["threads", "post", "trial", "--message", "Reply", "--reply-to", "msg_seed", "--map", "selection.yaml", "--member", "0", "--checkout", "/trusted/home"]);
    for (const incomplete of [{ map: "selection.yaml" }, { member: 0 }, { checkout: "/trusted/home" }]) {
      expect(() => threadArgs({ action: "open", path: "trial", ...incomplete })).toThrow();
    }
    expect(() => threadArgs({ action: "open", path: "trial", pin, position, ...selected })).toThrow(/either/);
    expect(() => threadArgs({ action: "post", path: "trial", message: "No", ...selected })).toThrow(/parent/);
    expect(() => threadArgs({ action: "post", path: "trial", message: "No", reply_to: ["msg_seed"], author: "Other", ...selected })).toThrow(/author/);
    const map = JSON.stringify({ map: { roots: [{ root_node_id: "n_0123456789abcdef01234567", sha: pin }], members: [{ root: 0, position, depth: "full" }] } });
    expect(authoredMember(map, 0)).toEqual({ pin, position });
    expect(() => authoredMember(map, 1)).toThrow(/no member 1/);
    expect(() => authoredMember("map: { roots: [], members: [wrong] }", 0)).toThrow(/members\[0\]: invalid_member_type/);
    expect(() => pinnedView({ pinned: "text", pin: "b".repeat(40), position }, "full", authoredMember(map, 0))).toThrow(/fallback/);
  });
  it("defaults local cold reads to surface and forwards bounded pages and tags", () => {
    expect(threadArgs({ action: "open", path: "trial" })).toEqual(["threads", "open", "trial", "--depth", "surface"]);
    expect(threadArgs({ action: "open", path: "trial", depth: "children", limit: 5, order: "newer" }))
      .toEqual(["threads", "open", "trial", "--depth", "children", "--limit", "5", "--order", "newer"]);
    expect(threadArgs({ action: "post", path: "trial", message: "Friction", reply_to: ["msg_one"], tags: ["friction", "ux"] }))
      .toEqual(["threads", "post", "trial", "--message", "Friction", "--reply-to", "msg_one", "--tags", "friction,ux"]);
    expect(() => threadArgs({ action: "open", path: "trial", limit: 0 })).toThrow(/positive/);
    expect(() => threadArgs({ action: "open", path: "trial", post: "msg_one", limit: 1 })).toThrow(/exact post/);
    expect(() => threadArgs({ action: "open", path: "trial", tags: ["friction"] })).toThrow(/only to local posts/);
    expect(() => threadArgs({ action: "list", reply_to: ["latest"] })).toThrow(/only to posts/);
    expect(threadArgs({ action: "list", reply_to: [], tags: [] })).toEqual(["threads", "list", "--depth", "summary"]);
    expect(threadArgs({ action: "open", path: "trial", reply_to: [], tags: [] })).toEqual(["threads", "open", "trial", "--depth", "surface"]);
    expect(threadArgs({ action: "close", path: "trial", message: "Done", tags: [], reply_to: [] }))
      .toEqual(["threads", "close", "trial", "--message", "Done"]);
    expect(() => threadArgs({ action: "post", path: "trial", message: "No", tags: ["a,b"] })).toThrow(/commas/);
    expect(() => threadArgs({ action: "post", path: "trial", message: "No", tags: [" "] })).toThrow(/non-empty/);
    expect(() => threadArgs({ action: "close", path: "trial", message: "No", tags: ["friction"] })).toThrow(/only to local posts/);
    expect(() => threadArgs({ action: "post", path: "trial", message: "No", limit: 2 })).toThrow(/opening/);
    expect(threadArgs({ action: "post", path: "trial", message: "Yes", reply_to: ["latest"] })).toContain("latest");
    expect(() => threadArgs({ action: "open", path: "x_" + "a".repeat(24), order: "newer" })).toThrow(/local-only/);
    expect(() => threadArgs({ action: "post", path: "x_" + "a".repeat(24), message: "No", tags: ["friction"] })).toThrow(/local-only/);
  });
  it("opens and replies to hosted ids through CLI; never guesses an authored pin", () => {
    const hosted = "x_" + "a".repeat(24);
    expect(threadArgs({ action: "open", path: hosted })).toEqual(["threads", "open", hosted]);
    expect(threadArgs({ action: "post", path: hosted, message: "Body", reply_to: ["msg_parent"] }))
      .toEqual(["threads", "post", hosted, "--reply-to", "msg_parent", "--message", "Body"]);
    expect(() => threadArgs({ action: "post", path: hosted, message: "Body", author: "Other" })).toThrow(/local-only/);
    expect(() => threadArgs({ action: "post", path: hosted, message: "Body", reply_to: ["n_post"] })).toThrow(/msg_/);
    expect(() => threadArgs({ action: "open", path: hosted, pin, position })).toThrow(/local-only/);
    expect(() => threadArgs({ action: "list", path: hosted })).toThrow(/local-only/);
    expect(() => threadArgs({ action: "close", path: hosted, message: "Done" })).toThrow(/Hosted close/);
    expect(() => threadArgs({ action: "open", path: "trial", pin })).toThrow(/HEAD/);
    expect(threadArgs({ action: "open", path: "trial", depth: "summary", pin, position }))
      .toEqual(["threads", "open", "trial", "--depth", "full", "--pin", pin, "--position", position]);
    const body = "---\nname: Authored\nsummary: Pinned summary\n---\n\nOld body\n";
    expect(pinnedView({ pinned: body, pin, position }, "summary", { pin, position })).toContain("Pinned summary");
    expect(pinnedView({ pinned: body, pin, position }, "full", { pin, position })).toBe(body);
    expect(() => pinnedView({ pin, position }, "full", { pin, position })).toThrow(/fallback/);
    expect(() => pinnedView({ pinned: body, pin: "b".repeat(40), position }, "full", { pin, position })).toThrow(/requested authored/);
    expect(() => threadArgs({ action: "close", path: "trial", message: "Done", map: "map.yaml" })).toThrow(/only accepts/);
    const root = mkdtempSync(join(tmpdir(), "is-thread-path-"));
    try {
      mkdirSync(join(root, "_threads/trial"), { recursive: true });
      writeFileSync(join(root, position), body);
      writeFileSync(join(root, "_threads/trial/README.md"), "# Trial");
      expect(threadPost(join(root, position), root)?.position).toBe(position);
      expect(threadPost(join(root, "_threads/trial/README.md"), root)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("hosted /threads argument contract", () => {
  it.each([24, 32])("accepts %i hex Thread ids, never leaks local depth, and requires msg_ parents", length => {
    const path = "x_" + "a".repeat(length);
    expect(threadArgs({ action: "open", path, limit: 10, cursor: "page" })).toEqual(["threads", "open", path, "--limit", "10", "--cursor", "page"]);
    expect(() => threadArgs({ action: "open", path, depth: "summary" })).toThrow(/local-only/);
    expect(threadArgs({ action: "post", path, reply_to: ["msg_parent"], message: "Reply", post_id: "msg_stable", map: "context.map.md" })).toEqual(["threads", "post", path, "--reply-to", "msg_parent", "--message", "Reply", "--map", "context.map.md", "--post-id", "msg_stable"]);
    expect(() => threadArgs({ action: "post", path, message: "No parent" })).toThrow(/reply_to/);
    expect(() => threadArgs({ action: "post", path, reply_to: ["n_old"], message: "Old parent" })).toThrow(/not converted/);
    // @ts-expect-error Agent ack is deliberately not in the tool contract.
    expect(() => threadArgs({ action: "ack", path, seq: 3 })).toThrow(/person's Unread/);
  });
  it("lists web Unread and starts a recipient/Map Thread", () => {
    expect(threadArgs({ action: "list", hosted: true, unread: true, cursor: "next" })).toEqual(["threads", "list", "--hosted", "--cursor", "next", "--unread"]);
    expect(threadArgs({ action: "new", hosted: true, recipients: ["@ada"], name: "Question", summary: "Why", message: "Hello", map: "context.map.md" })).toEqual(["threads", "new", "--hosted", "--message", "Hello", "--name", "Question", "--summary", "Why", "--recipients", "@ada", "--map", "context.map.md"]);
  });
});

it("requires an explicit threads-only CLI capability, not an old successful help response", () => {
  expect(threadsOnlyCapability({ schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: false })).toBe(true);
  for (const value of [null, {}, { transport: "/exchanges" }, { schema: "ideaspaces.threads.capabilities.v1", transport: "/threads", legacy_exchange_fallback: true }]) expect(threadsOnlyCapability(value)).toBe(false);
  expect(needsHostedThreads({ action: "list" })).toBe(true);
  expect(needsHostedThreads({ action: "open", path: "x_" + "a".repeat(24) })).toBe(true);
  expect(needsHostedThreads({ action: "list", path: "." })).toBe(false);
});

it("keeps explicit directory and x_-prefixed local paths local", () => {
  expect(threadArgs({ action: "list", path: "." })).toEqual(["threads", "list", ".", "--depth", "summary"]);
  expect(threadArgs({ action: "open", path: "x_notes" })).toEqual(["threads", "open", "x_notes", "--depth", "surface"]);
});
