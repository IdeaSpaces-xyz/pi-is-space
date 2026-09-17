---
name: is-setup
description: >
  Set up the place someone is describing — a space for their knowledge, or an
  agent with a role. Use when someone names a thing they want to keep, track,
  or organize — a knowledge base, a vault for transcripts, a repository for
  the team's KPIs, notes on a topic, a small CRM — or a helper they want to
  work with: an assistant, a sales agent, a critique partner. Also on the
  direct asks: "set up a space", "add ideaspaces here", "create an agent",
  "make me an agent", or questions about the contract. Talks first — what this
  place is, how work goes, what the agent does alone — then runs
  `ideaspaces create` via the resolved CLI (`--agent` for an agent) and writes
  what was agreed into the Agreement. Not for building software — someone
  coding an app wants code, not a space.
allowed-tools: "is_write is_commit is_auth edit read write bash"
---

# Setup an Ideaspace

Canonical protocols: read [purpose elicitation](../../reference/purpose-elicitation.md) and [repo context](../../reference/repo-context.md) when eliciting direction or judging how an existing repo should be scaffolded.

**Goal:** look → talk → reflect back → `ideaspaces create` → write what was agreed into `_agent/agreement.md` → commit → offer publish.

A space is one folder with one contract file, `_agent/agreement.md`, that says what the place is and how work goes here. The conversation is the work; the CLI is the scaffold writer. It lands the Agreement with every section as a **prompt**, and this skill's job is that no prompt is left standing.

**Pi command available:** `/is-setup` runs the CLI's dry-run/apply with Pi-native preview and confirmation — the scaffold step only. The conversation before it and the writing after it are this skill.

This skill is the **conversational layer** around the IdeaSpaces CLI. The conversation lives here; the file writes live in the CLI. That keeps one source of truth — change the CLI's templates, the skill's behavior updates automatically.

The extension resolves the IdeaSpaces CLI and exposes it to Bash as `$IS_CLI_PATH` when available. Define this helper in any `bash` command that invokes the CLI so local dev, installed packages, and PATH installs all work:

```bash
is_cli() {
  if [ -n "$IS_CLI_PATH" ] && [ -f "$IS_CLI_PATH" ]; then
    case "$IS_CLI_PATH" in
      *.js) node "$IS_CLI_PATH" "$@" ;;   # dev: a .js bundle needs node
      *) "$IS_CLI_PATH" "$@" ;;           # a compiled sidecar runs directly
    esac
  else
    ideaspaces "$@"
  fi
}
```

Don't offer unprompted. Wait for a signal — "set up a space", "I want somewhere for my X", "make me an assistant" — or a directory the user wants structured.

## Two arrivals, one skill

Read the signal before proceeding:

- **Create a space** — a place for knowledge: notes, decisions, research, a project's memory. Signals: "set up a space", "add ideaspaces here", "I want somewhere that keeps growing", a folder the user wants structured. → Follow [`create-a-space.md`](create-a-space.md).
- **Create an agent** — a folder that *is* someone: "create an agent", "make me a research assistant", "something that does X for me". → Follow [`create-an-agent.md`](create-an-agent.md).

Someone who says "assistant", "persona", or "personality" wants an agent; take the word they used, don't correct it.

## What both create paths share

Both procedures run the same shape. The details — what to listen for, the questions, the reflect-back — are in the two files above; this is the skeleton.

1. **Look before speaking.** Read the folder with `bash` (`find`, `test`, `rg`) and `read`; `git rev-parse --is-inside-work-tree` for the repo. Say what you found in a line. Change nothing.

   | Found | It means |
   |---|---|
   | `_agent/agreement.md` | Already an ideaspace. The CLI refuses; offer to edit the Agreement instead. |
   | `_agent/foundation.md` | The older shape. It still loads; offer [migrate-to-agreement](../../reference/migrate-to-agreement.md) rather than scaffolding beside it. |
   | `_agent/always.md` / `rules.md` / `soul.md` | Legacy. The CLI errors; the content moves into an Agreement by hand. |
   | Markdown files, no `_agent/` | Content already here. Read a few before asking — the story is partly in them. |
   | `.github/`, `package.json`, `Cargo.toml`, … | A code repo. A space can sit beside code; the CLI keeps `_agent/` private (gitignored) unless `--shared`. An agent's folder is not a code repo — propose a sibling folder. |
   | `CLAUDE.md`, `.gitignore` | The CLI won't overwrite either; it appends `.gitignore` defaults under a header. |

2. **Draw out.** Open with a story or a task, not a form. Listen for what the Agreement needs; ask only for what is missing *and* needed before the first move. Cases, in their words.

3. **Reflect back** in the shape the file will take. Revise until they recognise it.

4. **Scaffold.** Dry-run, show the plan, then apply on a yes:

   ```bash
   is_cli create [<name>] [--agent] [--shared]
   is_cli create [<name>] [--agent] [--shared] --yes
   ```

   The CLI writes `_agent/agreement.md` — referencing the knowledge kind, or the agent kind with `--agent` — plus a short `CLAUDE.md` (or `CLAUDE.local.md` in a private code repo), `.gitattributes`, and `.gitignore` defaults, then `git init -b main` and an exact-path initial commit as a **best-effort finalize**. If Git is unavailable the space still exists, unversioned, and the CLI prints the recovery commands. **Relay the CLI's own stdout; don't assume a commit happened.**

5. **Replace the prompts.** Use native `edit` on `_agent/agreement.md` — section by section, with what was agreed. Keep the frontmatter the CLI wrote; change only `name` and `summary` (two dense sentences). Show the file once more.

6. **Check it loads.** `is_cli navigate --json` — `manifest.contractSource` must be `agreement`; if `contract_invalid` appears, a frontmatter line is wrong.

7. **Commit** on a yes, by explicit path, with `is_commit` — only `_agent/agreement.md` (and `CLAUDE.md` if you touched it). Never a bare git commit in a folder someone else may have staged work in.

8. **Offer what comes next — don't do it.** Publish (`/is-publish`), the first Note if the story contained one, a skill (**is-shape**) if a repeatable procedure surfaced, `purpose.md` when they can say in a paragraph why the place exists and it is not the same paragraph as "what this place is".

Do **not** write `purpose.md`, `now.md`, or an empty `skills/`. They come when there is something real to put in them.

## Don'ts

- **Don't scaffold before the conversation.** A folder full of prompts nobody replaced is worse than no folder. The plan-then-apply split is the CLI's contract; the talk-then-write order is this skill's.
- **Don't write character the person did not give.** Thin is honest; invented is not. A short section that says it will fill in from real sessions is right.
- **Don't reimplement** what the CLI does. Run the bundle. The CLI is the source of truth for scaffold logic; this skill is the conversation around it.
- **Never overwrite existing `CLAUDE.md`.** The CLI doesn't; if the user has one, append a short pointer to `_agent/agreement.md` only if they want it.
- **Never delete or modify existing markdowns.** They're the user's data.
- **Don't `git init` outside the CLI.** If you `git init` first the CLI sees an existing repo and adapts.
- **Never push automatically.** Local-first by default. `/is-publish` only when the user explicitly says so.

## Confirm

Summarize what landed:

- `_agent/agreement.md` — written from the conversation, no prompts left standing
- `CLAUDE.md` (or `CLAUDE.local.md`) pointing at it
- `.gitattributes` + `.gitignore` defaults
- Version history: an initial commit **only if git ran** — the CLI's stdout says whether the space is versioned. If it reported "Working locally — no version history yet," relay that (and the `git init …` follow-up) instead of claiming a commit.

> "You're set. Next session will start oriented to your space. Run `/is-publish` when you're ready to host this remotely."

## What comes next

- **`/is-publish`** — host this space remotely (login + provision + push)
- **is-capture** — propose saving knowledge during work
- **is-reflect** — propose updating direction when it drifts
- **is-writing** — writing standard for Notes
- **is-space** — navigation, Two Roles, the contract reference

## Recovery

If anything goes sideways during scaffold:

- The CLI's plan is dry-run by default — re-run without `--yes` to preview again
- In a **versioned** space, partial changes can be cleaned up with `git status` + `git restore` (or `git clean -n` to preview untracked files). If the space is **unversioned** (no git), there's no git recovery surface — edit or remove the scaffolded files directly
- The CLI is idempotent on existing files (won't overwrite `CLAUDE.md`, won't double-append `.gitignore` block) — re-running with `--yes` is safe
