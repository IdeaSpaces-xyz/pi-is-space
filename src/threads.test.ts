import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredMember, pinnedView, threadArgs, threadPost } from "./threads.js";

const pin = "a".repeat(40);
const position = "_threads/trial/post.md";

describe("local Thread CLI adapter", () => {
  it("lists only local rows, opens three rungs without ack, and posts/ closes with author", () => {
    expect(threadArgs({ action: "list" })).toEqual(["threads", "list", ".", "--depth", "summary"]);
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
  it("opens and replies to hosted ids through CLI; never guesses an authored pin", () => {
    const hosted = "x_" + "a".repeat(24);
    expect(threadArgs({ action: "open", path: hosted, depth: "summary", new: true }))
      .toEqual(["threads", "open", hosted, "--depth", "summary", "--new"]);
    expect(threadArgs({ action: "open", path: hosted, depth: "surface", post: "n_post" }))
      .toEqual(["threads", "open", hosted, "--depth", "surface", "--post", "n_post"]);
    expect(threadArgs({ action: "open", path: hosted, depth: "children", since: "2026-10-07" }))
      .toEqual(["threads", "open", hosted, "--depth", "children", "--since", "2026-10-07"]);
    expect(threadArgs({ action: "post", path: hosted, message: "Body", name: "Reply", summary: "Why" }))
      .toEqual(["threads", "reply", hosted, "--message", "Body", "--name", "Reply", "--summary", "Why"]);
    expect(() => threadArgs({ action: "post", path: hosted, message: "Body", name: "Reply", summary: "Why", author: "Other" })).toThrow(/logged-in/);
    expect(() => threadArgs({ action: "post", path: hosted, message: "Body", name: "Reply", summary: "Why", reply_to: ["n_post"] })).toThrow(/cannot carry in_reply_to/);
    expect(() => threadArgs({ action: "open", path: hosted, pin, position })).toThrow(/Hosted Threads cannot/);
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
