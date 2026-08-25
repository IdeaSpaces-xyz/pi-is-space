import { describe, expect, it } from "vitest";
import type { PathRevision } from "@ideaspaces/protocol";
import { SessionCaptureLedger } from "./capture-ledger.js";

const A: PathRevision = { worktree: "a", index: "a", head: null };
const B: PathRevision = { worktree: "b", index: "b", head: "a" };

describe("SessionCaptureLedger", () => {
  it("separates review snapshots from all-eligible captures", () => {
    const ledger = new SessionCaptureLedger();
    ledger.recordReview("/one", "notes/a.md", A);

    expect(ledger.reviewedRevision("/one", "notes/a.md", "a")).toEqual(A);
    expect(ledger.capturedPaths("/one")).toEqual([]);

    ledger.recordCapture("/one", "notes/b.md", B);
    expect(ledger.capturedPaths("/one")).toEqual(["notes/b.md"]);
  });

  it("isolates repositories and refreshes only already-owned paths", () => {
    const ledger = new SessionCaptureLedger();
    ledger.recordCapture("/one", "notes/a.md", A);
    ledger.recordCapture("/two", "notes/b.md", A);

    ledger.refreshCaptured("/one", [
      { path: "notes/a.md", revision: B },
      { path: "notes/unowned.md", revision: B },
    ]);

    expect(ledger.capturedRevision("/one", "notes/a.md")).toEqual(B);
    expect(ledger.capturedPaths("/one")).toEqual(["notes/a.md"]);
    expect(ledger.capturedPaths("/two")).toEqual(["notes/b.md"]);
  });

  it("removes committed ownership without discarding review history", () => {
    const ledger = new SessionCaptureLedger();
    ledger.recordCapture("/one", "notes/a.md", A);
    ledger.removeCaptured("/one", ["notes/a.md"]);

    expect(ledger.capturedPaths("/one")).toEqual([]);
    expect(ledger.reviewedRevision("/one", "notes/a.md", "a")).toEqual(A);
  });
});
