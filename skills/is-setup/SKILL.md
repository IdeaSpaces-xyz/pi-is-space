---
name: is-setup
description: >
  Set up the place someone is describing — a space for their knowledge, or an
  agent with a role. Use when someone names a thing they want to keep, track,
  or organize — a knowledge base, a vault for transcripts, a repository for
  the team's KPIs, notes on a topic, a small CRM — or a helper they want to
  work with: an assistant, a sales agent, a critique partner. Also on the
  direct asks: "set up a space", "add ideaspaces here", "create an agent",
  "make me an agent", or questions about the contract. Inspects what's here,
  confirms, then runs `ideaspaces create` via the resolved CLI (`--agent` for
  an agent with its own character and point of view, drawn out in
  conversation). Not for building software —
  someone coding an app wants code, not a space.
allowed-tools: "is_write is_commit is_auth edit read write bash"
---

# Setup an Ideaspace

Canonical protocols: read [purpose elicitation](../../reference/purpose-elicitation.md) and [repo context](../../reference/repo-context.md) when eliciting direction or judging how an existing repo should be scaffolded.

**Goal:** detect → confirm → run `ideaspaces create` → capture purpose / now / next in conversation when content emerges.

**Pi command available:** for human-triggered setup, prefer `/is-setup`. It runs the same CLI dry-run/apply flow with Pi-native preview and confirmation. Use this skill when the agent needs the protocol, when `/is-setup` is unavailable, or when purpose/now/next elicitation continues after the scaffold.

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

Don't offer unprompted. Wait for a signal — "set up a space", "add ideaspaces here", "create an agent", or detection of a directory the user wants structured.

## Create an agent

An agent is a space shaped as a **point of view**: the five-file `_agent/` contract *is* the character (see [form-primitive](../../reference/form-primitive.md), Creating Agents). The space is not knowledge *about* the agent — it is the position the agent looks from, and the tree becomes its memory.

1. **Name it.** Ask what the agent should be called (letters, digits, spaces, `. _ -`; the CLI refuses names that would not survive frontmatter). The agent gets its own folder.
2. **Scaffold.** Dry-run, confirm, apply:

   ```bash
   is_cli create <name> --agent
   is_cli create <name> --agent --yes
   ```

   The foundation lands with **placeholder prompts** in Character, Boundaries, and What-this-agent-is-not — meant to be replaced in conversation, never left standing.
3. **Elicit the character — the heart of the flow.** Draw it out from real examples, not adjectives: *"Walk me through a task you'd hand this agent. What did a good result look like? Where would you not trust it?"* Three to five traits grounded in practice; boundaries as things it refuses or never claims without checking; one neighboring role it should not be confused with.
4. **Replace the prompts.** Use native `edit` on `_agent/foundation.md` (contract files carry the character, not Note frontmatter), show the result, and on confirmation commit with `is_commit` using explicit paths.
5. **Offer skills.** If a repeatable procedure surfaced, capture it into `_agent/skills/` (is-shape). A Pi session launched in the agent's folder acquires its root skills natively at session start.
6. **Purpose / now stay emergent** — elicit when there is real signal, or let the drift rule surface them next session.

The agent is used by launching Pi in its folder: the session reads who the agent is and inhabits it. Publishing works like any space.

## 1. Inspect (read-only)

Read the cwd before acting. Surface what was found in plain language. No side effects until the user confirms.

| Signal | What it tells us |
|---|---|
| Markdown files | Content already here. Could be notes, docs, or both. |
| `.git/` | Already a git repo. The CLI won't re-init. |
| `_agent/foundation.md` present | Already a complete ideaspace. The CLI will refuse; tell the user to edit `_agent/` directly. |
| `_agent/always.md` / `rules.md` / `soul.md` | Old shape. The CLI errors today; tell the user this is unimplemented. |
| `CLAUDE.md` | Agent orientation already configured. CLI won't overwrite. |
| `.github/`, `package.json`, `Cargo.toml`, etc. | Code-repo signal. CLI defaults to private `_agent/` + `CLAUDE.local.md`. |

Use `bash` (`find`, `test`, `rg`) and `read` for inspection. Use `bash` for `git rev-parse --is-inside-work-tree`.

## 2. Reflect

Surface the findings and propose what'll happen:

> "I see 12 markdown files and a git repo here, no `_agent/` yet. I'll add the ideaspace seed (foundation + guide files in `_agent/`, a CLAUDE.md, and a `.gitignore` block). Your existing markdowns won't be touched. OK?"

Confirm intent. The skill doesn't auto-decide.

## 3. Dry-run, then apply

The CLI has a built-in `--yes`-gated dry-run. Use it as a preview before applying:

```bash
is_cli create
```

Without `--yes`, this prints the plan and exits 0 without writing. Show the plan to the user, get a final confirmation, then apply:

```bash
is_cli create --yes
```

For a code repo where the user wants shared (committed) `_agent/`, add `--shared`:

```bash
is_cli create --yes --shared
```

The CLI writes `_agent/foundation.md`, `_agent/guide.md`, `CLAUDE.md` (or `CLAUDE.local.md`), `.gitattributes`, and `.gitignore` defaults first. A shared scaffold mints portable `root_node_id` into the foundation before login; a code repo's private gitignored `_agent/` remains unstamped. Git init + the exact-path initial commit are a best-effort finalize. If Git is unavailable, the Space still exists with local identity but no version history, and the CLI prints the recovery commands.

**Why seed-only:** the scaffolded foundation explains its own shape — the seed names the emergent files, and the drift rule fires from the files themselves. Nothing to restate here.

## 4. Capture purpose / now / next in conversation

For each of these, draw the content out and write the file when there's real content. **Skip the file if the user has nothing to say** — missing files are honest "not captured yet" signals; the next session's agent will surface them again.

1. **Purpose** — *"Why does this space exist? What's it for?"* Two-sentence answer becomes `_agent/purpose.md`. If a `README.md` is already present, propose a draft from it.
2. **Now** — *"What are you working on right now?"* Single paragraph becomes `_agent/now.md`.
3. **Next** — *"What's queued after now?"* Optional. Vague is OK.

Use `is_write` for these (Layer 1 frontmatter — `name`, `summary`). Don't write Purpose *for* the user — elicit and reflect back; the space's own capture rule governs the boundary. After each capture, commit it as its own capture commit with `is_commit` (explicit `paths` or session-owned `all=true`), not a broad git sweep.

## 5. Offer publish

After scaffold (and capture, if any), suggest the natural next step:

> "Want to host this remotely so you can access it from other devices and agent sessions? I can walk you through publishing — try `/is-publish`, or just say the word."

Don't run publish without explicit confirmation — it's a structural change and triggers OAuth login if not already done.

## Don'ts

- **Don't reimplement** what the CLI does. Run the bundle. The CLI is the source of truth for scaffold logic; this skill is the conversation around it.
- **Never overwrite existing `CLAUDE.md`.** The CLI doesn't; if the user has one, the bundle skips writing it. Append an `## Ideaspace` section manually if they want orientation pointers.
- **Never delete or modify existing markdowns.** They're the user's data. The CLI doesn't touch them either — verify if you ever bypass the CLI.
- **Don't `git init` outside the CLI.** The CLI handles it. If you `git init` first the CLI sees an existing repo and adapts.
- **Never overwrite an existing `.gitignore`.** The CLI appends under a `# ideaspace defaults` header.
- **Never push automatically.** Local-first by default. Use `/is-publish` (or the underlying `ideaspaces publish`) only when the user explicitly says so.

## Confirm

Summarize what landed:

- `_agent/foundation.md` + `_agent/guide.md` scaffolded (the seed)
- `_agent/purpose.md` / `now.md` / `next.md` if captured in conversation; missing if skipped
- `CLAUDE.md` (or `CLAUDE.local.md`) added
- `.gitattributes` + `.gitignore` defaults
- Initial commit + any capture commits

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
- Partial scaffolds can be cleaned up with `git status` + `git restore` (or `git clean -n` to preview untracked files)
- The CLI is idempotent on existing files (won't overwrite `CLAUDE.md`, won't double-append `.gitignore` block) — re-running with `--yes` is safe
