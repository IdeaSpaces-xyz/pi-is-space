import { describe, it, expect } from "vitest";
import { parseMountEnv } from "./mounts.js";

describe("parseMountEnv (IS_MOUNTS intake)", () => {
  it("splits a comma-separated list, trims, drops empties", () => {
    expect(parseMountEnv("/a, /b ,/c")).toEqual(["/a", "/b", "/c"]);
  });

  it("returns [] for undefined or empty (no mounts is the default)", () => {
    expect(parseMountEnv(undefined)).toEqual([]);
    expect(parseMountEnv("")).toEqual([]);
    expect(parseMountEnv(" , ,")).toEqual([]);
  });

  it("dedupes repeated entries", () => {
    expect(parseMountEnv("/a,/a,/b")).toEqual(["/a", "/b"]);
  });
});
