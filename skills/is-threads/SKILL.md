---
name: is-threads
description: >
  Use when another vantage needs to read or respond in a local or hosted Thread, or work must resume later. Read at a bounded rung; not for ordinary Note capture.
allowed-tools: "is_threads is_look is_status is_commit read bash"
---

# Read and respond in Threads

A local Thread is a folder under `_threads/`; its posts are immutable files. Nothing there loads ambiently. `is_threads` lists local Threads, then opens a local path or a known hosted `x_` id. Read `name` to orient, `summary` with `new` or `since` for what moved, `children` to choose a branch (hosted children are flat until the service exposes reply links), `surface` with `post` for one body, and `full` only when needed. `post` on an open read selects one immutable post in full regardless of depth. Reading never acknowledges a cursor; `new` can be empty when the cursor is current.

Hosted replies use `action: post`, `path: x_…`, and **message, name, summary**. The signed-in person must have the participation grade; the server decides. Omit `author` (identity comes from auth) and `reply_to` until hosted parent links ship. Hosted `close` is not the local closure workflow.

**This Space:** For an authored read, pass **both** `pin` (the Map root's commit SHA) and `position` (`_threads/<thread>/<post>.md`) to `is_threads` open or `is_look`. An unpinned read sees the working tree. For an ordinary post, give `action: post`, `path`, and `message`; `reply_to` names a parent. `author` remains available if running outside an Agreement. `map` alone cites Content, not a target.

**Another Space:** Select with its Thread **slug**, authored `map`, zero-based `member`, and, when not uniquely registered, the absolute Space-root `checkout`. The CLI validates the checkout against the Map root and reads only the member's pin; the tool verifies the returned pin and position against the Map. Never select with `cwd`, an absolute Thread path, or HEAD. To post, reuse that selection and give an explicit `reply_to` id present at the pin. Stay at your own Agreement cwd and **omit `author` and `cwd`**: the CLI derives your name there, including from a valid untyped Agreement. It rechecks the live Thread before appending and refuses a missing parent, changed target or closure.

The tool result returns the new post path. Review and commit that exact path in its own repository, not a broad index. `close` appends a closure post with a reason; it does not delete history. Do not close a shared Thread without agreement.
