import { describe, expect, it } from "vitest";
import {
  buildPiCommitTrailers,
  canonicalPiCoAuthor,
  resolvePiAgentPrincipal,
} from "./trailers.js";

describe("Pi local-effect trailers", () => {
  it("preserves explicit and identity-derived Pi principal spellings", () => {
    expect(resolvePiAgentPrincipal("writer", "person:tester@ideaspaces")).toBe(
      "agent:writer@ideaspaces",
    );
    expect(resolvePiAgentPrincipal("agent:writer@ideaspaces", "other@example.com")).toBe(
      "agent:writer@ideaspaces",
    );
    expect(resolvePiAgentPrincipal(undefined, "person:tester@ideaspaces")).toBe(
      "agent:tester-pi@ideaspaces",
    );
    expect(resolvePiAgentPrincipal(undefined, "other@example.com")).toBeUndefined();
  });

  it("canonicalizes the co-author without doubling the domain", () => {
    expect(canonicalPiCoAuthor("agent:tester-pi@ideaspaces")).toBe(
      "tester-pi <agent:tester-pi@ideaspaces>",
    );
    expect(canonicalPiCoAuthor("tester-pi <agent:tester-pi@ideaspaces>")).toBe(
      "tester-pi <agent:tester-pi@ideaspaces>",
    );
  });

  it("builds structured optional trailers", () => {
    expect(
      buildPiCommitTrailers("capture", {
        changeId: "chg_pf3b-test",
        principal: "agent:tester-pi@ideaspaces",
        sessionId: "sess-test",
      }),
    ).toEqual({
      op: "capture",
      change_id: "chg_pf3b-test",
      conversation: "sess-test",
      co_authored_by: ["tester-pi <agent:tester-pi@ideaspaces>"],
    });
  });
});
