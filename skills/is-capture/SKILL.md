---
name: is-capture
description: >
  Propose saving knowledge to the space when something crystallizes — a decision
  is made, understanding shifts, research produces a finding, or context would
  save the next session time. Proposes, doesn't auto-save. NOT for code, tasks,
  or preferences.
allowed-tools: "is_write is_status is_commit is_sync read bash"
user-invocable: false
---

# Capture

## When to Propose

- **Decision made.** "We're going with X because Y." Highest-value capture — prevents relitigating.
- **Understanding shifted.** Something got articulated that wasn't clear before.
- **Research produced a finding.** Took effort to produce, would take effort to reproduce.
- **Pattern emerged.** Same thing surfaced three times — the common thread is worth naming.
- **Context that saves time.** Next session would need this to be productive.

**Don't propose** when it's already in code/git, is a temporary task detail, is a personal preference (use agent memory), or the conversation is still forming.

## How

Brief. Don't interrupt flow.

> "That decision about [X] is worth capturing. Want me to write it to the space?"

If yes:

1. `bash` (`find`/`rg`) first to avoid duplicates; `read` the target area for context.
2. `is_write` to capture with Layer 1 frontmatter (`name`, `summary`). It stages the file, tracks it in IdeaSpaces session state, and returns a content `sha`.
3. For a refinement to a file just written, call `is_write` again with `if_match: <sha>` from the previous response. For a first update to an existing file, call `is_status({ path })` first and use the returned `sha` as `if_match`.
4. **Confirm before saving.** On user agreement, call `is_commit({ message, tracked: true })` or pass explicit `paths`. It commits only captured/tracked paths, not unrelated staged user work. If the user runs `/is-commit`, treat that as the confirmation step and don't re-ask.
5. Optionally `is_sync` to push committed captures. If the user runs `/is-sync`, treat that as the user's requested sync path.

Follow [is-writing](../is-writing/SKILL.md) standard.

If no: drop it. Don't re-ask.

## Rhythm

One or two captures per meaningful session. Not every session produces one.

After meaningful captures, check: does the Now still match? → **is-reflect**
