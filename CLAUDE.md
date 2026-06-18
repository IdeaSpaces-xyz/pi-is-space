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
- `is_conversation` — conversation-flow primitive; show/name/describe the current local flow over Pi's existing JSONL session
- `is_recall` — conversation-retrieval primitive; map/search/excerpt the local session tree, including compacted entries, without raw JSONL spelunking
- `is_cleanup` — conversation-window primitive; previews/applies active-window cleanup by keeping a checkpoint, compacting raw prior turns, and leaving JSONL recoverable
- `is_auth` — login/logout for optional sync

Keep agent-facing language intent-first: orient, capture, sync, reflect. Do not make agents choose between equivalent backends at the top level.

Pi-native commands for human-facing flow:

- `/is-setup` — preview and scaffold the `_agent/` seed contract with confirmation
- `/is-status` — show capture/sync state and refresh UI
- `/is-commit` — review staged captures, collect a message, confirm, commit staged knowledge
- `/is-sync` — dry-run, confirm, sync committed captures
- `/is-conversation` — show/name/describe the current local conversation flow over Pi's existing JSONL session
- `/is-recall` — map/search/excerpt the current local conversation tree
- `/is-cleanup` — show/cancel a pending active-context cleanup
- `/is-publish` — check scaffold/branch state, confirm destination, publish remotely, retry through login if needed

Runtime guardrails:

- Native `write` / `edit` to markdown or `_agent/` files inside an ideaspace get an intent-level capture nudge in the tool result.
- Nested code repos inside a parent ideaspace stay silent unless they carry their own `_agent/`.
- Session switch/fork prompts when staged captures are uncommitted; non-interactive mode cancels conservatively.

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, search, code/config editing, git, moves, and deletes.

No `sw_*` tools in this package.

## Session Awareness

On session start, walk up from `cwd` looking for `_agent/`, use `@ideaspaces/sdk` to assemble awareness, and inject it before agent turns. Awareness includes position, git/capture state, Now/tree/context summaries, operating skills, and changes since last session when available. Missing `_agent/purpose.md` / `_agent/now.md` are drift signals, not placeholders to silently fill.

## Skills

Use-case layer shipped in `skills/`, grouped by role:

- Daily loop: is-orient, is-capture, is-sync, is-reflect
- Space lifecycle: is-setup, is-publish, is-shape
- Conversation hygiene: is-conversation, is-cleanup, is-recall
- Reference: is-space, is-writing

Keep the layering clear: skills express user intent, tools are primitives, commands are human-triggered Pi UI flows.

Shared protocol content lives in `reference/`, generated from the SDK canonical skill catalog with `npm run build:reference`. Keep Pi entrypoint skills surface-specific; update shared capture/writing/awareness/shaping protocols in the SDK, then regenerate `reference/`.

Capture flow: user intent → `is-capture` → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-sync`. Reflect and shape use the same capture boundary when they change shared agreement. Cleanup is a separate workshop-hygiene loop: when active context is cluttered, preview with `is_cleanup action="preview" scope="active-window"`, agree on `tailTurns` if recent wording should remain exact, get confirmation, then apply with `action="apply"`. Cleanup builds on Pi-native compaction/tree primitives: normal compaction entries, `/tree` labels for anchors, exact recent tail preservation, and deterministic cleanup-aware branch summaries when navigating away from cleaned branches. Arbitrary middle-range cleanup is not first-class yet.

## Development

```bash
pi install .  # full extension + skills package
pi -e .       # quick extension-only test
```

## Migration

`pi-sw-space` is legacy naming and legacy remote-first surface (`sw_*`). New work goes here.
