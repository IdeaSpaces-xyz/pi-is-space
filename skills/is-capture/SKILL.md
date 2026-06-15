---
name: is-capture
description: >
  Preserve agreed understanding in the ideaspace when the user says capture,
  remember, save this, write this into the space, or when a decision/finding has
  crystallized. The skill chooses the mechanism: `is_write` for Notes, native
  edits for existing docs/specs, then `is_commit` for the agreement boundary.
allowed-tools: "is_write is_status is_commit is_sync is_cleanup read edit write bash"
user-invocable: false
---

# Capture

Capture is the agreement moment: conversation becomes shared state.

Do not make the user or agent choose between `write`, `is_write`, `git add`, and `is_commit` at the top level. The intent is **capture**. This skill chooses the mechanism.

Canonical protocols: read [capture](../../reference/capture.md) and [writing](../../reference/writing.md) when the task needs the full capture and writing standards.

## When to Propose

- **Decision made.** "We're going with X because Y." Highest-value capture — prevents relitigating.
- **Understanding shifted.** Something got articulated that wasn't clear before.
- **Research produced a finding.** Took effort to produce, would take effort to reproduce.
- **Pattern emerged.** Same thing surfaced three times — the common thread is worth naming.
- **Context that saves time.** Next session would need this to be productive.

**Don't propose** when it's already in code/git, is a temporary task detail, is a personal preference, or the conversation is still forming.

## Mechanism Choice

| Situation | Use |
|---|---|
| New or updated knowledge Note | `is_write` — it creates frontmatter, stages, tracks, and returns `sha` |
| Existing spec/doc/README/agent contract edit | native `edit` / `write`, then commit the agreed paths |
| File move/delete | native `bash` (`git mv`, `rm`) |
| User asks to sync/share after capture | `is-sync` / `is_sync` |

`is_write` is a capture primitive, not the outer intent. Reach for it inside this skill when the target is a Note that should carry Layer 1 frontmatter (`name`, `summary`) and optional Layer 2 fields (`tags`, `attached_to`).

## How

Brief. Don't interrupt flow.

> "That decision about [X] is worth capturing. Want me to write it to the space?"

If yes:

1. Search first (`bash` with `find`/`rg`) to avoid duplicates; `read` the target area for context.
2. Choose the mechanism:
   - Note capture → `is_write`.
   - Existing doc/spec/contract refinement → native `edit` / `write`.
3. For `is_write` refinements, use safe updates:
   - first update to an existing file: `is_status({ path })` → use returned `sha` as `if_match`
   - refinement of a file just written: use the prior `is_write` response `sha`
   - `force: true` only after re-reading and reconciling divergent content
4. Show what changed when useful. The user confirms the capture boundary.
5. Commit with `is_commit({ message, all: true })` for staged knowledge, or explicit `paths` for native edits. Never sweep unrelated staged work.
6. Optionally use **is-sync** / `is_sync` to align with remote.
7. Cleanup is separate from capture. After a meaningful capture or any natural boundary where context is cluttered, offer a cleanup preview:
   > "Want a cleanup preview — what stays live, what leaves active context, and rough savings?"
   Call `is_cleanup` with `action: "preview"`. If the user confirms the plan, call `is_cleanup` again with `action: "apply"`, passing the checkpoint, what remains active, what can be dropped, and captured paths. The extension auto-remembers only the most recent captures as a safety bound; pass explicit `captures` when the checkpoint represents older or native-file captures.

If the user runs `/is-commit`, treat that as confirmation and don't re-ask. If the user says no, drop it and don't re-ask.

## Commit message

Use the space's commit convention when present (for example `_agent/skills/commit.md`) — it defines the message shape and the provenance trailers. Don't restate the trailer format here.

## Rhythm

One or two captures per meaningful session. Not every session produces one.

After meaningful captures, check: does Now still match? → **is-reflect**
