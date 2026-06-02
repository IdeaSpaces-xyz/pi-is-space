# CLAUDE.md — pi-is-space

Pi extension for IdeaSpaces. Local-first parity with the Claude Code plugin.

## Principle

Thin wrapper only. Behavior lives in the IdeaSpaces CLI and SDK.

```txt
Agent (Pi) → pi-is-space → IdeaSpaces CLI --json → SDK → local files / optional remote sync
```

## Tool Surface

IdeaSpaces-aware tools:

- `is_write` — frontmatter-aware Note writes; stages, tracks, and returns `sha`
- `is_status` — capture/git state and file `sha` for safe updates
- `is_commit` — explicit save; commits only tracked or explicit capture paths
- `is_sync` — integrates remote changes and pushes committed captures
- `is_auth` — login/logout for optional sync

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, search, code/config editing, git, moves, and deletes.

No `sw_*` tools in this package.

## Session Awareness

On session start, walk up from `cwd` looking for `_agent/`, use `@ideaspaces/sdk` to assemble awareness, and inject it before agent turns. Missing `_agent/purpose.md` / `_agent/now.md` are drift signals, not placeholders to silently fill.

## Skills

Use-case layer shipped in `skills/`:

- is-setup, is-publish, is-space, is-writing, is-capture, is-reflect

Capture flow: `is_write` → refine with returned `sha` or `is_status({ path })` → user confirms → `is_commit` → optional `is_sync`.

## Development

```bash
pi install .
# or
pi -e .
```

## Migration

`pi-sw-space` is legacy naming and legacy remote-first surface (`sw_*`). New work goes here.
