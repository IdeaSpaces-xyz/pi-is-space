// Build reference/ from the SDK's canonical skill catalog via readSkill().
//
// Pi keeps surface-specific entrypoint skills in skills/is-*/SKILL.md. The
// shared protocols they read live in reference/ and are generated from
// @ideaspaces/sdk so Pi, Claude Code, MCP resources, and CLI consumers stay on
// one catalog.
//
// reference/ is committed as a vendored distribution artifact. Re-run after
// bumping the SDK dependency.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSkills, readSkill } from "@ideaspaces/sdk";

const root = dirname(fileURLToPath(import.meta.url));
const dst = join(root, "reference");

let skills;
try {
  skills = await listSkills();
} catch {
  console.error("✗ SDK skill catalog unavailable — run `npm install` first.");
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
