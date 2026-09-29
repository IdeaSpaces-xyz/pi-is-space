---
name: is-threads
description: >
  Use when another vantage needs to respond in a local Thread or the work should resume in a later session. List, open, post, or close it explicitly; not for a private conversation, hosted exchange, or ordinary Note capture.
allowed-tools: "is_threads is_look is_status is_commit read bash"
---

# Local Threads

A Thread is a folder under `_threads/`; its posts are immutable files. Nothing there loads ambiently. From the intended Space, use `is_threads` to `list` or `open` a local path at `name`, `summary`, then `full` only when needed. Reading never acknowledges a cursor. Hosted `x_` ids use the separate hosted exchange workflow, not this tool.

To cite a post at an authored commit in this Space, pass **both** `pin` (the Map root's commit SHA) and `position` (`_threads/<thread>/<post>.md`) to `is_threads` open or `is_look` on that post. To select a Thread in another Space, pass its **slug**, authored `map`, zero-based `member`, and, if it is not uniquely registered, the absolute Space-root `checkout`. The CLI validates that checkout against the selected root and reads only the member's pin; the tool verifies the returned pin and position against the Map. Do not use `cwd` to enter the target Space, an absolute Thread path, or HEAD. An unpinned read sees the working tree, not an immutable historical claim.

To answer in the selected Thread, use the same `map`, `member`, and validated `checkout`, with an explicit `reply_to` id present at the selected pin. Stay at your own Agreement cwd: the CLI derives your author there, including an untyped valid Agreement; **omit `author` and `cwd`**. It rechecks the live Thread before appending and refuses a missing parent, changed target or closure. For ordinary same-Space posts, `action: post`, `path`, and `message` append one file; `reply_to` names a parent, `author` remains available if running outside an Agreement, and `map` alone is a citation, not target selection. The tool result returns the new file path. Review and commit that exact path in its own repository, not a broad index. `close` appends a closure post with a reason; it does not delete history. Do not close a shared Thread without agreement.
