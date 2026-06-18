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
# quick extension-only test; install for the full extension + skills package
pi -e /path/to/pi-is-space
```

## Tools

The package has three surfaces:

- **Skills** — agent procedures for user intent (`is-capture`, `is-sync`, `is-cleanup`).
- **Tools** — low-level primitives the skills call (`is_write`, `is_commit`, `is_recall`).
- **Commands** — human-triggered Pi UI flows (`/is-sync`, `/is-cleanup`).

Pi's native `read`, `edit`, `write`, and `bash` cover navigation, inspection, and ordinary edits. `pi-is-space` adds IdeaSpaces-aware primitives used by the skills and commands:

| Tool | What |
|---|---|
| `is_status` | Inspect git/capture state, or return a file `sha` for safe Note updates. |
| `is_write` | Capture primitive: create/update a markdown Note with Layer 1 frontmatter, stage it in git, and return a content `sha`. Normally reached through the `is-capture` skill. |
| `is_commit` | Capture primitive: commit only explicit paths or all staged knowledge after confirmation; never sweep unrelated staged work. |
| `is_sync` | Sync primitive: integrate remote changes and push committed captures; refuses while staged knowledge remains uncommitted. |
| `is_conversation` | Show or update the current named local conversation flow over Pi's existing JSONL session. |
| `is_recall` | Map, search, or excerpt the current local conversation tree, including compacted entries recoverable from Pi session state. |
| `is_cleanup` | Preview/apply active-window context cleanup: keep a checkpoint, optionally keep an exact recent tail, compact older raw discussion out of active context, and keep JSONL history recallable. |
| `is_auth` | Log in / out for optional remote sync. |

## Commands

Human-facing IdeaSpaces actions are Pi-native commands:

| Command | What |
|---|---|
| `/is-setup` | Preview and scaffold the `_agent/` seed contract with Pi UI confirmation. |
| `/is-status` | Show git/capture state and refresh the footer/widget. |
| `/is-commit` | Review staged captures, enter a commit message, confirm, then commit them. |
| `/is-sync` | Run `sync --dry-run`, confirm the plan, then sync committed captures. |
| `/is-conversation` | Show or name/describe the current local conversation flow (an index over Pi's existing session JSONL). |
| `/is-recall` | Map/search/excerpt the current local conversation tree without reading raw JSONL directly. |
| `/is-cleanup` | Show or cancel a pending context cleanup. |
| `/is-publish` | Confirm destination, retry through login if needed, then publish the space remotely. |

When captures await commit, the extension shows a small widget near the editor so state stays visible without reminder spam.

## Runtime guardrails

The extension watches native `write` / `edit` results. If a markdown or `_agent/` file inside the active ideaspace is changed with native tools, the tool result gets a short nudge to use the capture flow when the edit represents durable shared understanding. Source-code writes stay silent, including markdown inside nested code repos unless that repo has its own `_agent/` ideaspace.

Before switching or forking sessions, Pi checks for staged captures awaiting commit. In interactive mode it offers to save now, proceed without saving, or cancel. In non-interactive mode it cancels conservatively when pending captures exist.

## Awareness

On session start, the extension walks up from `cwd` looking for `_agent/`, formats the awareness block via `@ideaspaces/sdk`, and injects it before each agent turn. The block includes position, git/capture state, Now, tree/context summaries, operating skills, and changes since the last session when available. Missing `_agent/purpose.md` or `_agent/now.md` are surfaced as drift signals.

## CLI

The package depends on `@ideaspaces/cli`. The extension resolves the CLI for tool calls and exposes the path to skills as `$IS_CLI_PATH` when available. Skills use a small `is_cli` shell helper so local development, installed packages, and PATH installs all work.

## Auth and publish

Auth is optional:

- `is_auth` — login (opens browser OAuth)
- `is_auth action="logout"` — clear credentials

To host a local space remotely, use `/is-publish`. It checks scaffold/branch state, confirms destination, then runs `ideaspaces publish`; if the CLI reports missing credentials, it offers login and retries.

## Skills and reference

Pi ships surface-specific entrypoint skills in four tiers:

**Daily loop**
- `is-orient` — understand where you are and what's active.
- `is-capture` — preserve agreed understanding.
- `is-sync` — align committed captures with remote.
- `is-reflect` — check whether declared direction still matches reality.

**Space lifecycle**
- `is-setup` — create the seed `_agent/` contract.
- `is-publish` — host a local space remotely for the first time.
- `is-shape` — evolve the `_agent/` agreement or reusable agent behavior.

**Conversation hygiene**
- `is-conversation` — name/describe the current local conversation flow.
- `is-cleanup` — preview/apply active-window context cleanup.
- `is-recall` — retrieve compacted or prior local conversation context by map/search/excerpt.

**Reference**
- `is-space` — compatibility/reference entrypoint; use when the user asks how IdeaSpaces works.
- `is-writing` — writing quality reference loaded by capture/writing tasks.

Shared protocol content lives in `reference/`, generated from the SDK canonical skill catalog with `npm run build:reference`. Entry skills stay Pi-specific while reading SDK-backed references such as `reference/capture.md`, `reference/writing.md`, and `reference/awareness.md` on demand.

Capture flow: user intent → `is-capture` skill → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-sync`. Cleanup is separate workshop hygiene: when context is cluttered, `is_cleanup action="preview" scope="active-window" tailTurns=...` shows what stays live, what exact recent tail remains, what leaves active context, and rough savings; after confirmation, `action="apply"` records the checkpoint and slides active context past older raw discussion while leaving the full Pi session tree recoverable through `/tree` and `is_recall`. Cleanup stays Pi-native: normal compaction entries, `/tree` labels for anchors, and deterministic cleanup-aware branch summaries when navigating away from cleaned branches. Arbitrary middle-range cleanup is not first-class yet; tail turns are the simple continuity knob.

See `MIGRATION.md` for mapping from legacy `pi-sw-space`.
