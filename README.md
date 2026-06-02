# pi-is-space

Pi extension for [IdeaSpaces](https://ideaspaces.xyz). Local-first: an ideaspace is a markdown folder with an `_agent/` contract, optional remote sync, and frontmatter-aware capture.

## Why this exists

`pi-is-space` is the Pi package counterpart to the Claude Code plugin.

Architecture:

```txt
Agent (Pi) → pi-is-space → IdeaSpaces CLI --json → SDK → local files / optional remote sync
```

The extension stays thin. Behavior lives in the IdeaSpaces CLI and SDK.

## Install

```bash
pi install /path/to/pi-is-space
# or run without installing
pi -e /path/to/pi-is-space
```

## Tools

Pi's native `read`, `edit`, `write`, and `bash` cover local navigation and editing. `pi-is-space` adds IdeaSpaces-aware tools for capture and optional sync:

| Tool | What |
|---|---|
| `is_write` | Create/update a markdown Note with Layer 1 frontmatter, stage it, track it in session state, and return a content `sha`. |
| `is_status` | Show git/capture state, or return a file `sha` for safe `is_write.if_match` updates. |
| `is_commit` | Commit only explicit or session-tracked capture paths after confirmation; never sweep unrelated staged work. |
| `is_sync` | Integrate remote changes and push committed captures; refuses while tracked captures remain uncommitted. |
| `is_auth` | Log in / out for optional remote sync. |

## Awareness

On session start, the extension walks up from `cwd` looking for `_agent/`, formats the awareness block via `@ideaspaces/sdk`, and injects it before each agent turn. Missing `_agent/purpose.md` or `_agent/now.md` are surfaced as drift signals.

## CLI

The package depends on `@ideaspaces/cli`. The extension resolves the CLI for tool calls and exposes the path to skills as `$IS_CLI_PATH` when available. Skills use a small `is_cli` shell helper so local development, installed packages, and PATH installs all work.

## Auth and publish

Auth is optional:

- `is_auth` — login (opens browser OAuth)
- `is_auth action="logout"` — clear credentials

To host a local space remotely, use `/is-publish` or run `ideaspaces publish` from inside the space.

## Skills

- `is-setup`
- `is-publish`
- `is-space`
- `is-writing`
- `is-capture`
- `is-reflect`

Capture flow: `is_write` → refine with returned `sha` or `is_status({ path })` → user confirms → `is_commit` → optional `is_sync`.

See `MIGRATION.md` for mapping from legacy `pi-sw-space`.
