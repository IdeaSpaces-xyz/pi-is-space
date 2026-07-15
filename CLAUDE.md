# CLAUDE.md — pi-is-space

Pi extension for IdeaSpaces. Local-first parity with the Claude Code plugin.

## Principle

Implement the ideaspace inhabitation loop as a natural Pi surface:

```txt
arrive → orient → inspect → act → capture → sync → reflect
```

The agent chooses intent; the extension/skills choose mechanism. Keep the wrapper thin. Behavior lives in the IdeaSpaces CLI and SDK.

```txt
Agent (Pi) → pi-is-space → IdeaSpaces CLI --json → SDK → local files / optional remote sync
```

## Tool Surface

IdeaSpaces-aware primitives:

- `is_status` — inspect capture/git state and file `sha` for safe updates
- `is_write` — capture primitive for frontmatter-aware Note writes; stages, tracks, and returns `sha`
- `is_commit` — capture primitive; commits only tracked or explicit capture paths
- `is_pull` — pull primitive; integrates remote changes into the local space (never pushes)
- `is_push` — push primitive; sends committed captures to the remote (refuses when behind — pull first)
- `is_auth` — login/logout for optional sync

Keep agent-facing language intent-first: orient, capture, push, pull, reflect. Do not make agents choose between equivalent backends at the top level.

Pi-native commands for human-facing flow:

- `/is-setup` — preview and scaffold the `_agent/` seed contract with confirmation
- `/is-status` — show capture/sync state and refresh UI
- `/is-commit` — review staged captures, collect a message, confirm, commit staged knowledge
- `/is-pull` — dry-run, confirm, integrate remote changes into the local space
- `/is-push` — dry-run, confirm, push committed captures to the remote
- `/is-publish` — check scaffold/branch state, confirm destination, publish remotely, retry through login if needed

Runtime guardrails:

- Native `write` / `edit` to markdown or `_agent/` files inside an ideaspace get an intent-level capture nudge in the tool result.
- Nested code repos inside a parent ideaspace stay silent unless they carry their own `_agent/`.
- Session switch/fork prompts when staged captures are uncommitted; non-interactive mode cancels conservatively.

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, search, code/config editing, git, moves, and deletes.

No `sw_*` tools in this package.

## Session Awareness

On session start, shell the IdeaSpaces CLI for awareness: `status` supplies capture/operating state and `navigate` supplies the composed contract, position, tree/context summaries, working set, repo catalog, drift, and changes since last session. The extension injects the combined block before agent turns; it does not import the SDK directly. Missing `_agent/purpose.md` / `_agent/now.md` are drift signals, not placeholders to silently fill.

## Skills

Use-case layer shipped in `skills/`, grouped by role:

- Daily loop: is-orient, is-capture, is-push, is-pull, is-reflect
- Space lifecycle: is-setup, is-publish, is-shape
- Reference: is-space, is-writing

Conversation hygiene lives in `pi-local-context` (`context-conversation`, `context-cleanup`, `context-recall`), not this Space connector.

Keep the layering clear: skills express user intent, tools are primitives, commands are human-triggered Pi UI flows.

Shared protocol content lives in `reference/`, generated from the protocol's canonical skill catalog as re-exported by the SDK (`npm run build:reference`). Keep Pi entrypoint skills surface-specific; update shared capture/writing/awareness/shaping protocols in `ideaspace-protocol`, release and bump the SDK, then regenerate `reference/`.

Capture flow: user intent → `is-capture` → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-push` (or `is-pull` first). Reflect and shape use the same capture boundary when they change shared agreement. Cleanup is local conversation hygiene, not Space connector behavior; use `context_cleanup` from `pi-local-context` when that package is installed.

## Development

```bash
npm run typecheck
npm test      # common MCP/Pi tool-contract conformance
npm run lint:skills
pi install .  # full extension + skills package
pi -e .       # quick extension-only test
```

## Migration

`pi-sw-space` is legacy naming and legacy remote-first surface (`sw_*`). New work goes here.
