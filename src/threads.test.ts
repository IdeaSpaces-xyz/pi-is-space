import { describe, expect, it } from "vitest";
import { pinnedView, threadArgs, threadPost } from "./threads.js";

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
  it("refuses hosted ids and implicit HEAD; projects only the pinned post", () => {
    expect(() => threadArgs({ action: "open", path: "x_" + "a".repeat(24) })).toThrow(/hosted/);
    expect(() => threadArgs({ action: "open", path: "trial", pin })).toThrow(/HEAD/);
    expect(threadArgs({ action: "open", path: "trial", depth: "summary", pin, position }))
      .toEqual(["threads", "open", "trial", "--depth", "full", "--pin", pin, "--position", position]);
    const body = "---\nname: Authored\nsummary: Pinned summary\n---\n\nOld body\n";
    expect(pinnedView({ pinned: body, pin, position }, "summary")).toContain("Pinned summary");
    expect(pinnedView({ pinned: body, pin, position }, "full")).toBe(body);
    expect(() => pinnedView({ pin, position }, "full")).toThrow(/fallback/);
    expect(threadPost("/home/_threads/trial/post.md", "/home")?.position).toBe(position);
    expect(threadPost("/home/_threads/trial/README.md", "/home")).toBeNull();
  });
});
