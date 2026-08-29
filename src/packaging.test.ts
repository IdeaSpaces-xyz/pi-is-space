import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pi installs git packages with `npm install --omit=dev` inside the clone
 * (pi-mono package-manager, getGitDependencyInstallArgs). Anything the
 * extension imports or shells at runtime must therefore live in
 * `dependencies` — a `--save-dev` pin bump silently breaks every
 * `pi install git:` user while local dev and CI (full installs) stay green.
 */
describe("packaging", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));

  it("runtime packages are dependencies, surviving Pi's --omit=dev install", () => {
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toContain("@ideaspaces/protocol");
    expect(deps).toContain("@ideaspaces/cli");
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    expect(devDeps).not.toContain("@ideaspaces/protocol");
    expect(devDeps).not.toContain("@ideaspaces/cli");
  });

  it("pins the root-identity protocol and account-free Fork/update CLI", () => {
    expect(pkg.version).toBe("0.1.13");
    expect(pkg.dependencies?.["@ideaspaces/protocol"]).toBe(
      "github:IdeaSpaces-xyz/ideaspace-protocol#e9b13e8d79da5fbd4c3cdd535e818ed9781258b2",
    );
    expect(pkg.dependencies?.["@ideaspaces/cli"]).toBe(
      "github:IdeaSpaces-xyz/cli#aabc9f2af43045c40cf2a425a9bbc3ac918dc2b3",
    );
  });

  it("pi host packages stay peers so managed installs never solve them", () => {
    const peers = Object.keys(pkg.peerDependencies ?? {});
    expect(peers).toContain("@earendil-works/pi-coding-agent");
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => d.startsWith("@earendil-works/"))).toEqual([]);
  });

  it("the pi manifest ships the extension entry and the skills catalog", () => {
    expect(pkg.pi?.extensions).toEqual(["./src/index.ts"]);
    expect(pkg.pi?.skills).toEqual(["./skills"]);
  });

  it("points skill-name authoring at the canonical rule and names Pi's consequence", () => {
    const skill = readFileSync(join(process.cwd(), "skills/is-shape/SKILL.md"), "utf-8");
    expect(skill).toContain("follow the exact rule and worked example in [form primitive]");
    expect(skill).toContain("Pi warns at startup when a loaded skill violates it");
    expect(skill).not.toContain("1–64 lowercase ASCII letters");
  });

  it("ships awareness-first orientation with an explicit stopping rule", () => {
    const skill = readFileSync(join(process.cwd(), "skills/is-orient/SKILL.md"), "utf-8");
    expect(skill).toContain("Treat that map as the first disclosure rung, not as a list of files to reload.");
    expect(skill).toContain("Do not reread contract, current-state, or README files whose summaries are represented in awareness.");
    expect(skill).toContain("Do not follow links during basic orientation.");
    expect(skill).toContain("then request an outline before one exact section");
    expect(skill).toContain("Use native `read` only when exact full-document or implementation evidence is required");
    expect(skill).not.toContain("Read by position, not search");
  });
});
