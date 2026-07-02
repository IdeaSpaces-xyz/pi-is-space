---
name: is-push
description: >
  Push an ideaspace when the user says push, share, send, or publish current
  state. Push sends your committed captures to the remote; it never pulls. If
  you are behind the remote, pull first. Capture first if changes aren't committed.
allowed-tools: "is_status is_commit is_push is_pull is_auth read bash"
---

# Push

Push sends your committed captures to the remote. It is one direction across the agreement boundary — it never integrates others' work in.

## Rule

- **Uncommitted captures?** They won't be pushed. Capture/commit first, or ask whether to leave them local.
- **Behind the remote?** Push refuses — run `is_pull` first, then push. You can't push over remote work.
- **Missing auth?** Use `is_auth` only when push reports credentials are needed.

## How

1. Inspect state with `is_status`.
2. If staged captures are still uncommitted, commit them first (or leave them local).
3. Preview when useful: `is_push({ dry_run: true })`.
4. If behind, pull first with `is_pull`, then push.
5. If the plan is safe, run `is_push`.
6. Report what pushed, or why nothing changed.

If the user invokes `/is-push`, treat that as the human-facing confirmation path and do not duplicate prompts.

## Watch for

- No upstream/remote: suggest `/is-publish` if the user wants to host this space remotely.
- Auth failure: offer `is_auth action="login"`, then retry push.

## After push

If push followed a meaningful capture, consider **is-reflect**: does Now, Purpose, or the local agreement still match reality?
