---
name: is-space
description: >
  Reference for working in an ideaspace — the five-file `_agent/` contract,
  Two Roles convention, and Pi tool surface. Use as a compatibility/reference
  entrypoint when the user asks how an ideaspace works. For active intents,
  prefer the loop skills: is-orient, is-capture, is-sync, is-reflect, is-shape.
allowed-tools: "is_write is_status is_commit is_sync is_conversation is_recall is_cleanup is_auth read edit write bash"
---

# Working in an Ideaspace

Canonical protocols: read [guide](../../reference/guide.md), [capture](../../reference/capture.md), [writing](../../reference/writing.md), or [awareness](../../reference/awareness.md) when the task needs the full shared standard. This entrypoint adds Pi-specific navigation and tool guidance.

An ideaspace is inhabited through a simple loop:

```text
arrive → orient → inspect → act → capture → sync → reflect
```

Pi handles **arrive** automatically with session-start awareness. For active work, pick the intent skill by tier:

**Daily loop** — `is-orient`, `is-capture`, `is-sync`, `is-reflect`.
**Space lifecycle** — `is-setup`, `is-publish`, `is-shape`.
**Conversation hygiene** — `is-conversation`, `is-cleanup`, `is-recall`.
**Reference** — `is-space`, `is-writing`.

You have three surfaces:

- **Skills** — agent procedures for user intent. Use these first.
- **Tools** — low-level primitives (`is_status`, `is_write`, `is_commit`, `is_sync`, `is_conversation`, `is_recall`, `is_cleanup`, `is_auth`). Skills choose these mechanisms; don't make backend choice the user's problem.
- **Commands** — human-triggered Pi UI flows (`/is-setup`, `/is-sync`, `/is-cleanup`). If the user invokes one, treat it as the confirmation path.

Native `read`, `edit`, `write`, and `bash` remain the default for navigation, search, source-code work, and ordinary doc edits.

## Start here

**No `_agent/` yet?** Suggest `/is-setup` — it walks the user through the contract scaffold and conversational seeding.

**Returning?** The SessionStart hook surfaces what's present inline along with each file's summary and any operating skills. If you need to refresh it, use the **is-orient** skill.

Read `_agent/foundation.md` and `_agent/guide.md` first when acting beyond the injected awareness — they always exist on a scaffolded space. Then `_agent/purpose.md`, `now.md`, `next.md` when present. **Missing files are first-class drift signals**: the contract names them, so absence means direction hasn't been captured. Surface this and propose capturing them in conversation before doing other work.

## The five-file `_agent/` contract

Every ideaspace carries an `_agent/` folder at root. Two layers:

**Seed** (always scaffolded by `ideaspaces create` / `/is-setup`):

| File | Role |
|---|---|
| `foundation.md` | What this place is, baseline behaviors. Lives only at the space root and always loads. |
| `guide.md` | How agent and human work together at this scope, anchored to foundation. |

**Emergent** (captured in conversation when content exists, not as placeholder writes):

| File | Role |
|---|---|
| `purpose.md` | Why this space exists. The North Star. |
| `now.md` | What's currently active. |
| `next.md` | What's queued. |

The contract is self-bootstrapping — `foundation.md` + `guide.md` name the emergent files, so an agent reading the seed sees the gap and proposes capturing the rest. Real content over placeholder filler.

Read all five at session start when present; surface the gap when not.

`CLAUDE.md` at the space root tells compatible agent harnesses where the contract is. Pi also injects an awareness block from `_agent/` at session start.

Branches (deeper directories) can refine via their own `_agent/` (any of guide / purpose / now / next) without re-declaring foundation. Most branches don't need their own — a `README.md` is enough when the agreement is light.

`.gitignore` is also part of the Agreement — the boundary between what's shared and what stays local. Drafts, scratch, secrets, per-developer context go there. Propose changes; never edit silently.

### Optional: `_agent/skills/`

A space can carry **operating skills** as markdown files in `_agent/skills/`. Each skill describes a procedure the agent should follow when working in this space — for example, `_agent/skills/commit.md` defining a three-tier commit shape. Skills are surfaced at session start (the awareness block lists them by name + summary), with full content loaded on demand when invoked.

Read a skill when the agent reaches for the procedure it describes. Don't preload — the listing is enough orientation; the body matters at the moment of use.

## Two Roles at every position

Every position in the tree holds two kinds of content. The folder convention enforces the split.

| Role | What | Folder convention |
|------|------|-------------------|
| **User content** | Notes — knowledge that accumulates | regular `.md` files |
| **Agent context** | Instructions that shape the agent | `_agent/`, `README.md` |

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

Replace-semantics: callers specify all Layer 1 + 2 fields they want set; existing frontmatter is replaced wholesale and the body is preserved. For local file moves, deletions, and metadata-only edits, use native `bash` (`git mv`, `rm`) and `edit`.

Layer 1 (required): `name`, `summary`.
Layer 2 (optional): `tags`, `attached_to`.

Safe update flow:

- First update to an existing file: call `is_status({ path })` to get `sha`, then `is_write({ path, content, if_match: sha })`.
- Refinement of a file just written: use the `sha` returned by the previous `is_write` response as the next `if_match`.
- `force: true` is the escape hatch after you've re-read and reconciled divergent content.

### `is_status` — capture state and file sha

- No path: shows git position plus staged IdeaSpaces captures awaiting commit.
- With `path`: returns single-file state, including `sha` for `is_write.if_match`.

### `is_commit` — explicit capture commit

Use inside capture after user confirmation. Commit only captured paths:

- `is_commit message="Capture decision" all=true` — commit all staged knowledge (markdown + `_agent/`)
- `is_commit message="Capture decision" paths=["notes/decision.md"]` — commit explicit paths

It never sweeps unrelated staged user work into the capture commit.

### `is_sync` — push committed captures

Use **is-sync** for the outer intent. `is_sync` integrates remote changes and pushes committed captures. It refuses while staged IdeaSpaces knowledge remains uncommitted. Use `dry_run: true` to preview.

### `is_conversation` — name the local flow

`is_conversation` shows or updates the current local conversation flow metadata. It indexes Pi's existing JSONL session with a stable conversation ID, name, and description; it does not move or sync raw conversation logs.

### `is_recall` — retrieve prior local context

`is_recall` maps, searches, or excerpts the current Pi conversation tree without requiring raw JSONL reads. Use it when compacted or prior turns may matter:

```
is_recall action="map"
is_recall action="search" query="review blockers" scope="compacted"
is_recall action="excerpt" entryId="abc12345"
```

It is deterministic in the current MVP: no generated summaries, only maps, matches, and excerpts from session state.

### `is_cleanup` — clean active context

`is_cleanup` is workshop cleanup for the active conversation window. It does not change shared understanding; capture does that. Cleanup keeps a checkpoint live, compacts prior raw discussion out of active context, and leaves the full Pi JSONL session recoverable via `/tree` and `is_recall`.

The current scope is `active-window`: sliding-window compaction of prior active-branch context. Pi's `/tree` branch summaries are adjacent branch cleanup; arbitrary middle-range cleanup is not first-class yet.

Prefer preview before apply:

```
is_cleanup action="preview"
          scope="active-window"
          checkpoint="What stays live..."
          keep="Open implementation questions..."
          drop="Tool noise and resolved debate..."
          captures=["roadmap/foo.md"]
```

After the user confirms:

```
is_cleanup action="apply"
          scope="active-window"
          checkpoint="What stays live..."
          keep="Open implementation questions..."
          drop="Tool noise and resolved debate..."
          captures=["roadmap/foo.md"]
```

This is sliding-window compaction, not surgical raw-turn editing. `keep` preserves selected state in the checkpoint; exact prior turns are pulled back with recall when needed.

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
