---
name: is-pull
description: >
  Pull an ideaspace when the user says pull, get the latest, or update from
  remote. Pull brings others' committed captures into the local space; it never
  pushes. Integrating requires a committed, clean tree — capture first if needed.
allowed-tools: "is_status is_commit is_pull is_auth read bash"
---

# Pull

Pull brings remote changes into the local ideaspace (fetch → rebase/merge). It is one direction across the agreement boundary — it never pushes your work out.

## Rule

- **Integrating rewrites the tree** — it requires a committed, clean tree. Uncaptured or uncommitted changes? Capture/commit first, or ask whether to leave them local.
- **Missing auth?** Use `is_auth` only when pull reports credentials are needed.

## How

1. Inspect state with `is_status`.
2. Preview when useful: `is_pull({ dry_run: true })`.
3. If there are staged captures or a dirty tree, do not pull yet — commit first.
4. If the plan is safe, run `is_pull`.
5. Report what integrated, or why nothing changed.

If the user invokes `/is-pull`, treat that as the human-facing confirmation path and do not duplicate prompts.

## Watch for

- No upstream/remote: suggest `/is-publish` if the user wants to host this space remotely.
- Conflicts during integrate: pull surfaces how to back out (abort, resolve, retry).
- Auth failure: offer `is_auth action="login"`, then retry pull.

## After pull

If new remote understanding landed, consider **is-reflect**: does Now, Purpose, or the local agreement still match reality?
