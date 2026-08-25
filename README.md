# IdeaSpaces for Pi

[![CI](https://github.com/IdeaSpaces-xyz/pi-is-space/actions/workflows/ci.yml/badge.svg)](https://github.com/IdeaSpaces-xyz/pi-is-space/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Give Pi a standard way to turn useful work into knowledge that survives the chat.

Useful decisions, findings, plans, and context should not disappear with the chat. This local-first package gives Pi a standard way to orient in your work, recognize when understanding has changed, and capture what matters as ordinary Markdown with git history.

The [protocol](https://github.com/IdeaSpaces-xyz/ideaspace-protocol) defines the repository shape and operating loop. `pi-is-space` makes that standard native to Pi through session awareness, capture skills, and safe commit/sync tools. Everything stays on your machine unless you choose to publish or sync it.

[Install IdeaSpaces](#install) · [Explore the protocol as an Ideaspace](https://ideaspaces.xyz/spaces/n_64dbf7878f05362337a6cda6) · [Use IdeaSpaces with Claude](https://github.com/IdeaSpaces-xyz/claude-code-plugin)

## Install

Install the extension and its skills directly from GitHub:

```bash
pi install git:github.com/IdeaSpaces-xyz/pi-is-space
```

Or try it for one run without adding it to your settings:

```bash
pi -e git:github.com/IdeaSpaces-xyz/pi-is-space
```

Pi packages execute code with your user permissions. Review the source before installing any third-party package.

## What you get

- **Awareness on arrival** — Pi reads the active `_agent/` agreement, current direction, tree, and recent movement.
- **Progressive inspection** — deepen from a document summary to its outline or one exact section before loading a full body.
- **Your space's skills, natively** — root `_agent/skills/` entries register as Pi skills at session start (listed by description, `/skill:name` invocable); branch skills surface as you navigate.
- **Deliberate capture** — when understanding crystallizes, Pi proposes preserving it, stages the agreed draft, and commits only after explicit confirmation.
- **Knowledge that compounds** — decisions and context become ordinary Markdown rather than remaining trapped in transcripts.
- **Native Pi flows** — tools and commands cover capture, commit, setup, publish, push, and pull without duplicating Pi's file tools.
- **Optional collaboration** — work fully offline, then publish or sync when you choose.

## How it works

`pi-is-space` makes the ideaspace inhabitation loop feel native in Pi:

```txt
arrive → orient → inspect → act → capture → sync → reflect
```

The agent chooses the intent; the package chooses the mechanism. Architecture stays thin:

```txt
Agent (Pi) → pi-is-space → @ideaspaces/protocol (local reads + explicit local effects)
                         → IdeaSpaces CLI (auth/sync/publish/share/setup + remote catalog)
```

The wrapper keeps harness placement and session behavior local while reusing the protocol's shape and the CLI's platform capabilities.

## Tools

The package has three surfaces:

- **Skills** — agent procedures for user intent (`is-capture`, `is-share`, `is-push`, `is-pull`).
- **Tools** — low-level primitives the skills call (`is_write`, `is_commit`).
- **Commands** — human-triggered Pi UI flows (`/is-push`, `/is-pull`, `/is-commit`).

Local conversation/session hygiene lives in `pi-local-context` (`context_conversation`, `context_recall`, `context_cleanup`). This package stays focused on Space state: awareness, capture, commit, push, pull, auth, setup, publish, and Share access.

Pi's native `read`, `edit`, `write`, and `bash` cover exact full-document evidence and ordinary edits. `pi-is-space` adds IdeaSpaces-aware primitives used by the skills and commands:

| Tool | What |
|---|---|
| `is_navigate` | Move home awareness focus, or inspect a mounted ideaspace as read-only reference. |
| `is_inspect` | Inspect one local Markdown file by summary, ATX outline, or exact section; never defaults to the full body. |
| `is_mount` / `is_unmount` | Add or remove read-only repositories from the conversation's working set. |
| `is_status` | Inspect git/capture state, or return a file's full revision and compatibility `sha` for safe Note updates. |
| `is_write` | Capture primitive: create/update a markdown Note with Layer 1 frontmatter, stage it in git, record its session revision, and return a content `sha`. Normally reached through the `is-capture` skill. |
| `is_commit` | Capture primitive: commit only explicit reviewed paths or this Pi session's captured paths after confirmation; never adopt unknown staged work. |
| `is_change_open` / `is_change_close` | Carry one decision's `Change-Id` across commits and repositories. |
| `is_pull` | Pull primitive: integrate remote changes into the local space; never pushes; refuses to integrate on staged/dirty tree. |
| `is_push` | Push primitive: send committed captures to the remote; refuses on uncommitted captures, and when behind — pull first. |
| `is_auth` | Log in / out for optional remote sync. |

## Commands

Human-facing IdeaSpaces actions are Pi-native commands:

| Command | What |
|---|---|
| `/is-setup` | Preview and scaffold the `_agent/` seed contract with Pi UI confirmation. |
| `/is-status` | Show git/capture state and refresh the footer/widget. |
| `/is-commit` | Review staged captures, enter a commit message, confirm, then commit them. |
| `/is-pull` | Run `pull --dry-run`, confirm the plan, then integrate remote changes. |
| `/is-push` | Run `push --dry-run`, confirm the plan, then push committed captures. |
| `/is-publish` | Confirm destination, retry through login if needed, then publish the space remotely. |

When captures await commit, the extension shows a small widget near the editor so state stays visible without reminder spam.

## Runtime guardrails

The extension watches native `write` / `edit` results. If a markdown or `_agent/` file inside the active ideaspace is changed with native tools, the tool result gets a short nudge to use the capture flow when the edit represents durable shared understanding. Source-code writes stay silent, including markdown inside nested code repos unless that repo has its own `_agent/` ideaspace.

Before switching or forking sessions, Pi checks for staged captures awaiting commit. In interactive mode it offers to save now, proceed without saving, or cancel. In non-interactive mode it cancels conservatively when pending captures exist.

## Awareness

On session start, the extension builds local awareness in-process from `@ideaspaces/protocol`: the structured Content manifest supplies position, fractal contract, tree/context summaries, recent activity, and drift; protocol git/path reads supply capture state; neutral workspace/root handles supply catalog facts. Pi renders its working-set and catalog roles and splits the block into two cache registers: the stable register (position, Now, tree, contract, skills, working set) enters the system prompt per prompt with deterministic bytes, so an unchanged session keeps its prompt-cache prefix; the volatile register (git State, since-last-session activity, catalog, drift, and the open-Change line) is appended per LLM call strictly after the last cache breakpoint, outside every cached prefix. Missing `_agent/purpose.md` or `_agent/now.md` remain drift signals.

## CLI

The package still depends on `@ideaspaces/cli` for auth, sync, publish/setup, recipient-shaped Share, and remote catalog discovery. It resolves the CLI for those calls and exposes the path to skills as `$IS_CLI_PATH` when available. Share is intentionally skill-mediated and CLI-backed in this release rather than exposed as a native `is_share` tool. Local path status, Markdown write, exact-path commit, Change minting, navigation, inspection, mounted orientation, and capture nudges execute in-process; remote-catalog refresh remains a best-effort platform call.

A host that drives pi one process per turn (e.g. the desktop) owns the conversation's durable working set and passes it as `$IS_MOUNTS` (comma-separated absolute paths) on the inherited env; at load the extension seeds its mounts from it, so a mount survives across turns without the agent re-running `is_mount`.

## Auth and publish

Auth is optional:

- `is_auth` — login (opens browser OAuth)
- `is_auth action="logout"` — clear credentials

To host a local space remotely, use `/is-publish`. It checks scaffold/branch state, confirms destination, then runs `ideaspaces publish`; if the CLI reports missing credentials, it offers login and retries.

## Skills and reference

Pi ships surface-specific entrypoint skills:

**Daily loop**
- `is-orient` — understand where you are and what's active.
- `is-capture` — preserve agreed understanding.
- `is-push` — send committed captures to the remote.
- `is-pull` — integrate remote changes into the local space.
- `is-reflect` — check whether declared direction still matches reality.

**Access**
- `is-share` — manage people, teams, and public/private visibility through recipient-shaped choices.

**Space lifecycle**
- `is-setup` — create the seed `_agent/` contract.
- `is-publish` — host a local space remotely for the first time.
- `is-shape` — evolve the `_agent/` agreement or reusable agent behavior.

Conversation hygiene is intentionally out of scope here; install `pi-local-context` for `context-conversation`, `context-cleanup`, and `context-recall`.

**Reference**
- `is-space` — compatibility/reference entrypoint; use when the user asks how IdeaSpaces works.
- `is-writing` — writing quality reference loaded by capture/writing tasks.

Shared protocol content lives in `reference/`, generated directly from the protocol's canonical skill catalog (`npm run build:reference`). Entry skills stay Pi-specific while reading references such as `reference/capture.md`, `reference/writing.md`, and `reference/awareness.md` on demand.

Capture flow: user intent → `is-capture` skill → maybe `is_write` for Notes or native edits for docs/specs → user confirms → `is_commit` → optional `is-push` (or `is-pull` first). Cleanup is separate local-context hygiene owned by `pi-local-context`; use `context_cleanup` from that package when available.

See [`MIGRATION.md`](MIGRATION.md) for mapping from legacy `pi-sw-space`.

## Status

Public preview. The local orientation and capture loop is in active use; the protocol and Pi package may still change before 1.0, and remote hosting is optional.

## License

[MIT](LICENSE)
