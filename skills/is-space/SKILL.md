---
name: is-space
description: >
  Reference for working in an ideaspace — the five-file `_agent/` contract,
  Two Roles convention, and Pi tool surface. Use as a compatibility/reference
  entrypoint when the user asks how an ideaspace works. For active intents,
  prefer is-orient, is-capture, is-share, is-push, is-pull, is-reflect, and is-shape.
allowed-tools: "is_write is_status is_commit is_push is_pull is_auth read edit write bash"
---

# Working in an Ideaspace

Canonical protocols: read [guide](../../reference/guide.md), [capture](../../reference/capture.md), [writing](../../reference/writing.md), or [awareness](../../reference/awareness.md) when the task needs the full shared standard. This entrypoint adds Pi-specific navigation and tool guidance.

An ideaspace is inhabited through a simple loop:

```text
arrive → orient → inspect → act → capture → push/pull → reflect
```

Pi handles **arrive** automatically with session-start awareness. For active work, pick the intent skill by tier:

**Daily loop** — `is-orient`, `is-capture`, `is-push` / `is-pull`, `is-reflect`.
**Access** — `is-share` for people, teams, and public/private visibility.
**Space lifecycle** — `is-setup`, `is-publish`, `is-shape`.
**Reference** — `is-space`, `is-writing`.

Local conversation hygiene (`context-conversation`, `context-cleanup`, `context-recall`) lives in `pi-local-context`, not this Space connector.

You have three surfaces:

- **Skills** — agent procedures for user intent. Use these first.
- **Tools** — low-level primitives (`is_status`, `is_write`, `is_commit`, `is_push`, `is_pull`, `is_auth`). Skills choose these mechanisms; don't make backend choice the user's problem.
- **Commands** — human-triggered Pi UI flows (`/is-setup`, `/is-push`, `/is-pull`, `/is-commit`, `/is-publish`). If the user invokes one, treat it as the confirmation path.

Native `read`, `edit`, `write`, and `bash` remain the default for navigation, search, source-code work, and ordinary doc edits.

## Start here

**No `_agent/` yet?** Suggest `/is-setup` — it walks the user through the contract scaffold and conversational seeding.

**Returning?** The SessionStart hook surfaces what's present inline along with each file's summary and any operating skills. If you need to refresh it, use the **is-orient** skill.

Read `_agent/foundation.md` and `_agent/guide.md` first when acting beyond the injected awareness — they always exist on a scaffolded space. Then `_agent/purpose.md`, `now.md`, `next.md` when present; a named-but-absent file is a drift signal — surface it and propose capturing before other work.

## The `_agent/` contract

The contract's shape is deliberately not restated here. Every scaffolded space carries it in its own `_agent/foundation.md` — the five files, seed vs emergent, the skills/perspectives dimensions, the `.gitignore` boundary — and the shared operating standard lives in [guide](../../reference/guide.md). Read the space's foundation; restating shape in entrypoints is how drift happens. Not in a space yet? `/is-setup` scaffolds the seed. Pi injects an awareness block from `_agent/` each turn.

Branches (deeper directories) refine via their own `_agent/` without re-declaring foundation; most branches need only a `README.md`. Operating skills in `_agent/skills/` are listed in the awareness block by name + summary — read a skill's body at the moment of use, don't preload.

## Two Roles at every position

Knowledge (regular `.md` files) and agent context (`_agent/`, `README.md`) — the protocol's split: the first is content that accumulates, the second is instruction read by position.

Within user content, voices can coexist at different branches. Don't mix them in one folder — use a subfolder to mark the shift:

- **Raw personal thinking** — one person's voice, pre-refinement. Own folder (e.g., `slow-thoughts/`, `journal/`).
- **Co-produced from conversation** — human + agent. Own folder or subfolder (e.g., `conversations/`, `captured/`). Who made it is recorded in the commit, not in frontmatter.
- **Stable concept docs** — refined, canonical. Top-level or `concepts/`.

When capturing from a conversation, check the target folder's voice before writing. If the folder is someone's raw personal thinking, don't write co-produced notes there — create a subfolder. See [is-writing](../is-writing/SKILL.md) for voice guidance and [is-capture](../is-capture/SKILL.md) for when to propose capture.

## Capture primitives

Use **is-capture** for the outer intent. It decides whether the mechanism is `is_write`, native edits, or a commit of explicit paths.

### `is_write` — create/update with Layer 1 frontmatter

Use inside capture when the target is a Note. Carries the writing standard. Better than raw filesystem `write` when the file should compound as a Note.

- `is_write path="analysis.md" content="..." name="Analysis" summary="Dense orientation"` — create or update the Note's frontmatter and body, stage it in git, and return a content `sha`
- Optional fields: `tags`, `attached_to`, `if_match`, `force`, `cwd`

Preserve-semantics: supplied Layer 1 + 2 fields patch existing frontmatter; unspecified and unknown fields survive. The supplied Markdown body replaces the prior body. For local file moves, deletions, and metadata-only edits, use native `bash` (`git mv`, `rm`) and `edit`.

Layer 1 (required): `name`, `summary`.
Layer 2 (optional): `tags`, `attached_to`.

Safe update flow:

- First update to an existing file: call `is_status({ path })` to get `sha`, then `is_write({ path, content, if_match: sha })`.
- Refinement of a file just written: use the `sha` returned by the previous `is_write` response as the next `if_match`.
- `force: true` is the escape hatch after you've re-read and reconciled divergent content.

### `is_status` — capture state and file revision

- No path: shows git position, staged IdeaSpaces knowledge, and paths captured by this Pi session.
- With `path`: returns worktree/index/HEAD revision facts plus the compatibility `sha` for `is_write.if_match`; status review alone does not make the path eligible for `all`.

### `is_commit` — explicit capture commit

Use inside capture after user confirmation. Commit only captured paths:

- `is_commit message="Capture decision" all=true` — commit all paths captured by this Pi session
- `is_commit message="Capture decision" paths=["notes/decision.md"]` — commit explicit paths

Tool `all` never adopts unrelated staged user work. Explicit paths remain available for confirmed native edits, moves, and deletes.

### `is_push` / `is_pull` — the two directions

Use **is-push** and **is-pull** for the outer intent — the two directions across the agreement boundary. `is_pull` integrates remote changes into the local space (never pushes); `is_push` sends committed captures to the remote (never pulls). Push refuses when behind — pull first. Both refuse while staged knowledge is uncommitted. Use `dry_run: true` to preview.

### Local conversation context

Conversation metadata, recall, and active-context cleanup are owned by `pi-local-context` through the neutral `context_conversation`, `context_recall`, and `context_cleanup` surfaces. Use that package when local Pi session history or compaction matters.

**`cwd` matters when you've `cd`-ed inside `bash`.** A `cd subdir` in a `bash` invocation changes that subprocess's cwd; it doesn't propagate back to Pi's extension process. If you've worked in a subdir during the session and then call `is_write` with a relative `path`, `is_write` resolves it against the Pi session cwd — likely the wrong tree.

Pass `cwd` whenever the agent's intended working directory differs from session start:

```
is_write path="_agent/purpose.md" content="..." name="Purpose" summary="..."
         cwd="/abs/path/to/the/space"
```

Default falls back to the Pi session cwd.

## `is_auth` — sync state

- `is_auth action="login"` — log in (opens browser for OAuth)
- `is_auth action="logout"` — clear credentials

Sync is opt-in. The extension works locally without auth.

To host a space remotely after login, run `/is-publish` or `ideaspaces publish` from inside the space directory. It creates a server-side bare repo, sets the local `user.email` to the OAuth-resolved identity, and pushes. Folder ↔ repo mapping persists at `~/.ideaspaces/spaces.json` so re-publishing from the same dir reuses the existing remote.

## Native tools for the rest

- **`bash`** — find by pattern (`find`, `rg --files`), search by content (`rg`), git operations, ad-hoc shell.
- **`read`** — read a file, optionally windowed.
- **`edit`**, **`write`** — modify files. Use `is_write` when the result is a Note (frontmatter, capture); use native `write` for source code, config, plain `README.md`.

## Patterns

- **Navigate before writing.** Use `bash` (`find` / `rg --files`) and `read` the target area first.
- **Search before creating.** Use `bash` (`rg`) to check if something similar exists.
- **Entities connect.** Add `attached_to` when writing a Note: `hostname:acme.com`, `person:alice`.

## Related skills

- **is-capture** — when to propose saving knowledge during work
- **is-reflect** — when to propose updating Purpose, Now, or structure
- **is-writing** — quality standard for summaries, sections, entities
- **is-setup** — conversational layer over `ideaspaces create` for a new or existing space
- **is-shape** — create `_agent/` primitives and perspectives
- **is-share** — manage people, teams, and public/private visibility without exposing backend coordinates
