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
- `is_sync` — sync primitive; integrates remote changes and pushes committed captures
- `is_auth` — login/logout for optional sync

Keep agent-facing language intent-first: orient, capture, sync, reflect. Do not make agents choose between equivalent backends at the top level.

Pi-native commands for human-facing flow:

- `/is-setup` — preview and scaffold the `_agent/` seed contract with confirmation
- `/is-status` — show capture/sync state and refresh UI
- `/is-commit` — review tracked captures, collect a message, confirm, commit tracked paths only
- `/is-sync` — dry-run, confirm, sync committed captures
- `/is-publish` — check scaffold/branch state, confirm destination, publish remotely, retry through login if needed

Runtime guardrails:

- Native `write` / `edit` to markdown or `_agent/` files inside an ideaspace get an intent-level capture nudge in the tool result.
- Nested code repos inside a parent ideaspace stay silent unless they carry their own `_agent/`.
- Session switch/fork prompts when session-tracked captures are uncommitted; non-interactive mode cancels conservatively.

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, search, code/config editing, git, moves, and deletes.

No `sw_*` tools in this package.

## Session Awareness

On session start, walk up from `cwd` looking for `_agent/`, use `@ideaspaces/sdk` to assemble awareness, and inject it before agent turns. Missing `_agent/purpose.md` / `_agent/now.md` are drift signals, not placeholders to silently fill.

## Skills

Use-case layer shipped in `skills/`:

- Loop skills: is-orient, is-capture, is-sync, is-reflect, is-shape
- Lifecycle/setup skills: is-setup, is-publish
- Reference skills: is-space, is-writing

Shared protocol content lives in `reference/`, generated from the SDK canonical skill catalog with `npm run build:reference`. Keep Pi entrypoint skills surface-specific; update shared capture/writing/awareness/shaping protocols in the SDK, then regenerate `reference/`.

Capture flow: user intent → `is-capture` → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-sync`.

## Development

```bash
pi install .
# or
pi -e .
```

## Migration

`pi-sw-space` is legacy naming and legacy remote-first surface (`sw_*`). New work goes here.
