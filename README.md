# pi-is-space

Pi extension for [IdeaSpaces](https://ideaspaces.xyz). Local-first: an ideaspace is a markdown folder with an `_agent/` contract, optional remote sync, and frontmatter-aware capture.

## Why this exists

`pi-is-space` makes the ideaspace inhabitation loop feel native in Pi:

```txt
arrive → orient → inspect → act → capture → sync → reflect
```

The agent chooses the intent; the package chooses the mechanism. Architecture stays thin:

```txt
Agent (Pi) → pi-is-space → IdeaSpaces CLI --json → SDK → local files / optional remote sync
```

Behavior lives in the IdeaSpaces CLI and SDK where possible.

## Install

```bash
pi install /path/to/pi-is-space
# or run without installing
pi -e /path/to/pi-is-space
```

## Tools

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, inspection, and ordinary edits. `pi-is-space` adds IdeaSpaces-aware primitives used by the capture and sync flows:

| Tool | What |
|---|---|
| `is_status` | Inspect git/capture state, or return a file `sha` for safe Note updates. |
| `is_write` | Capture primitive: create/update a markdown Note with Layer 1 frontmatter, stage it, track it in session state, and return a content `sha`. Normally reached through the `is-capture` skill. |
| `is_commit` | Capture primitive: commit only explicit or session-tracked capture paths after confirmation; never sweep unrelated staged work. |
| `is_sync` | Sync primitive: integrate remote changes and push committed captures; refuses while tracked captures remain uncommitted. |
| `is_auth` | Log in / out for optional remote sync. |

## Commands

Human-facing IdeaSpaces actions are Pi-native commands:

| Command | What |
|---|---|
| `/is-setup` | Preview and scaffold the `_agent/` seed contract with Pi UI confirmation. |
| `/is-status` | Show git/capture state and refresh the footer/widget. |
| `/is-commit` | Review session-tracked captures, enter a commit message, confirm, then commit only those paths. |
| `/is-sync` | Run `sync --dry-run`, confirm the plan, then sync committed captures. |
| `/is-publish` | Confirm destination, retry through login if needed, then publish the space remotely. |

When captures await commit, the extension shows a small widget near the editor so state stays visible without reminder spam.

## Runtime guardrails

The extension watches native `write` / `edit` results. If a markdown or `_agent/` file inside the active ideaspace is changed with native tools, the tool result gets a short nudge to use the capture flow when the edit represents durable shared understanding. Source-code writes stay silent, including markdown inside nested code repos unless that repo has its own `_agent/` ideaspace.

Before switching or forking sessions, Pi checks for session-tracked captures awaiting commit. In interactive mode it offers to save now, proceed without saving, or cancel. In non-interactive mode it cancels conservatively when pending captures exist.

## Awareness

On session start, the extension walks up from `cwd` looking for `_agent/`, formats the awareness block via `@ideaspaces/sdk`, and injects it before each agent turn. Missing `_agent/purpose.md` or `_agent/now.md` are surfaced as drift signals.

## CLI

The package depends on `@ideaspaces/cli`. The extension resolves the CLI for tool calls and exposes the path to skills as `$IS_CLI_PATH` when available. Skills use a small `is_cli` shell helper so local development, installed packages, and PATH installs all work.

## Auth and publish

Auth is optional:

- `is_auth` — login (opens browser OAuth)
- `is_auth action="logout"` — clear credentials

To host a local space remotely, use `/is-publish`. It checks scaffold/branch state, confirms destination, then runs `ideaspaces publish`; if the CLI reports missing credentials, it offers login and retries.

## Skills and reference

Pi ships surface-specific entrypoint skills mapped to the inhabitation loop:

- `is-orient` — understand where you are and what's active
- `is-capture` — preserve agreed understanding
- `is-sync` — align committed captures with remote
- `is-reflect` — check drift after meaningful change
- `is-shape` — change the `_agent/` agreement or reusable agent behavior
- `is-setup` — scaffold a space
- `is-publish` — host a local space remotely
- `is-space` — compatibility/reference entrypoint
- `is-writing` — writing quality reference

Shared protocol content lives in `reference/`, generated from the SDK canonical skill catalog with `npm run build:reference`. Entry skills stay Pi-specific while reading SDK-backed references such as `reference/capture.md`, `reference/writing.md`, and `reference/awareness.md` on demand.

Capture flow: user intent → `is-capture` skill → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-sync`.

See `MIGRATION.md` for mapping from legacy `pi-sw-space`.
