// Build reference/ directly from the protocol's canonical skill catalog.
//
// Pi keeps surface-specific entrypoint skills in skills/is-*/SKILL.md. The
// shared protocols they read live in reference/, while Pi, Claude Code, MCP
// resources, and CLI consumers resolve the same protocol-owned catalog.
//
// reference/ is committed as a vendored distribution artifact. Re-run after
// bumping the protocol dependency.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSkills, readSkill } from "@ideaspaces/protocol";

const root = dirname(fileURLToPath(import.meta.url));
const dst = join(root, "reference");

let skills;
try {
  skills = await listSkills();
} catch {
  console.error("✗ Protocol skill catalog unavailable — run `npm install` first.");
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });

for (const s of skills) {
  try {
    const skill = await readSkill(s.name);
    await writeFile(join(dst, `${s.name}.md`), skill.content, "utf-8");
    console.log(`✓ reference/${s.name}.md`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ reference/${s.name}.md — ${message}`);
    process.exit(1);
  }
}

console.log(`Built reference/ with ${skills.length} skill(s) via readSkill().`);
