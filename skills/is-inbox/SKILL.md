---
name: is-inbox
description: >
  Read and reply to direct Inbox messages, ask a person a question about shared
  Content, optionally attach an explorable Map, or follow a Thread, Node, or
  repository for updates. Use when the user says check my Inbox, read this
  message, follow this, show what is new, ask the owner/person about this, send
  an inquiry, or reply. Not for giving someone access to a Space; that is
  is-share.
allowed-tools: "is_auth is_follow read bash"
---

# Direct Inbox

Inbox is the person-accountable feedback loop around shared Content. A local agent may help compose
and invoke it, but every read and send acts as the logged-in person. Never substitute a bare Agent
credential or reproduce the flow with raw API calls.

Hosted conversations use `ideaspaces threads` in the IdeaSpaces CLI. `ideaspaces inbox` is a
legacy alias, not the path to teach. The extension exposes the resolved CLI as
`$IS_CLI_PATH` when available. Define this helper in any `bash` command that invokes it:

```bash
is_cli() {
  if [ -n "$IS_CLI_PATH" ] && [ -f "$IS_CLI_PATH" ]; then
    case "$IS_CLI_PATH" in
      *.js) node "$IS_CLI_PATH" "$@" ;;
      *) "$IS_CLI_PATH" "$@" ;;
    esac
  else
    ideaspaces "$@"
  fi
}
```

No separate install or native Inbox tool is required.

## Read

Listing and reading are read-only and need no confirmation. Neither moves a cursor unless `--ack` is
explicit:

```bash
is_cli threads list
is_cli threads list --new --depth name
is_cli threads read "<thread-id>"
is_cli threads read "<thread-id>" --new --depth full
```

`threads list` includes local and hosted Threads; `threads read x_…` addresses a hosted exchange.
For local-only Thread work, use `is-threads` and its `is_threads` tool instead of this hosted workflow. For a known hosted Thread id, `is-threads` and its `is_threads` tool can also read it at the same five rungs.
Use `--since <position|ISO date|hosted Note id>` for a supplied hosted boundary, `--kind message|reframe` to narrow
hosted results, and `--depth name|summary|children|surface|full` for the disclosure rung (hosted children are flat until reply-parent links ship). Access requests are not
Threads: the pinned CLI temporarily requires `is_cli inbox list --kind request` for them. Use normal
human output unless exact structured fields are needed; then append `--json`. Preserve the CLI's
distinction between an empty result and an unavailable service. A hosted Thread's Notes remain
visible only to its human parties; a followed Node may expose authorized event envelopes without
granting Thread membership.

## Follow and acknowledge

Following is deliberate listening. Use `is_follow` for standalone subscription writes rather than raw API calls:

- `{ action: "follow", source: "thread", id: "x_…" }`
- `{ action: "follow", source: "node" | "repo", id: "n_…" }`
- `{ action: "ack", source: "thread", id: "x_…", position: 42 }`
- `{ action: "unfollow", source: "thread", id: "x_…" }`

Only explicit acknowledgement advances the stored cursor. Plain listing and reading never do. When
the person asks to read and catch up to the latest position in one step, `is_cli threads read
"<thread-id>" --new --ack` deliberately combines the read with acknowledgement; use `is_follow`
with `action: "ack"` when the exact position is already known.

## Decide whether the Note needs a Map

The Note is the contribution itself: the ask, problem, finding, decision, or context the recipient
should understand directly. A Map is optional. It answers **what broader material are we talking
about?** by giving the recipient ordered pointers they can explore progressively.

Before sending, choose deliberately:

- **No Map** — the Note and Thread history are sufficient.
- **Inherit** — the current Agreement or subject Map still frames this reply; do not repeat it.
- **Attach a Map** — the Note introduces material the recipient may need to explore.
- **Attach and reframe** — the new material changes what the Thread is currently about.

Ask: *Can the recipient understand and act on this Note from the current Thread frame?* If yes, a
Mapless message is complete. Never attach a Map as ceremony, and never copy broader material into the
message merely because the Map path is unavailable.

When a new Map is warranted:

1. Put the primary Note first, usually at `surface`; add only the few supporting members needed, often
   at `name` or `summary`.
2. Preview the exact member order, annotations, and disclosure ceilings before sending.
3. Ensure positioned Notes are committed, pushed, indexed, and bound to their hosted Space. A local
   path is not shared context.
4. Send only through a CLI surface that accepts the reviewed selection. Pinned CLI 0.2.11 accepts
   `threads send --map` and `threads reply --map`. For a reply, inspect the usage from
   `is_cli threads reply` **without a thread id** (it exits nonzero without sending); look for
   `[--map <selection.json>]`. `threads --help` is a generic overview, not reply-specific.
   Older CLIs may silently ignore an unknown flag; update the CLI; do not use raw API calls.
5. Read the sent message back at `--depth full` and expand one member before claiming the Map or Note
   was shared.

`ideaspaces map select` currently builds a bounded reviewed selection profile. If it cannot express
an intended multi-Note Map, surface that honestly rather than hand-authoring an unreviewed transport
envelope.

## Choose the send coordinate

A new inquiry needs:

- one exact target coordinate (`n_…`) the message is about — a Content Note, an Actor profile, or a
  Process the sender can read;
- optionally one person, as an email address or `@handle`. Omit the person to reach the target's
  owner;
- a short name, dense summary, and Markdown message.

For the current Space root, `is_cli status --json` exposes its declared root identity. A canonical
`/repos/n_…` URL also carries the root coordinate. For a nested target, use an exact coordinate
already supplied by the user, Map, or hosted reader; never guess one from a local path.

Before sending, state the target, the recipient (or that it goes to the owner), and the message. Ask
for confirmation when any were inferred or composed beyond the user's request. A request that
already names them counts as confirmation; do not ask twice.

## Send and reply

Quote every user-provided value. Pass longer Markdown through stdin rather than flattening it. Mint
one stable send id per intended message and reuse that exact id only when retrying the same immutable
send after an ambiguous network failure.

```bash
is_cli threads send "@owner" \
  --about "n_0123456789abcdef01234567" \
  --name "Question" \
  --summary "One decision needs clarification" \
  --send-id "<stable-send-id>" \
  --message "What should happen next?"

# No person named: the Node's owner receives it.
is_cli threads send \
  --about "n_0123456789abcdef01234567" \
  --name "Bug" \
  --summary "share invite 404s" \
  --send-id "<stable-send-id>" \
  --message "..."

printf '%s\n' "# Answer" "" "Keep the boundary narrow." | \
  is_cli threads reply "<thread-id>" \
    --name "Answer" \
    --summary "A bounded answer" \
    --send-id "<stable-reply-id>"
```

A reply needs no recipient or target: the original message fixes both. Never change the send id while
retrying changed content; changed content is a new message and needs a new id.

If authentication is required, offer `is_auth action="login"`, then retry the identical operation.

## Report the result

For a send or reply, report the message id, the target it remains attached to, and — when no person
was named — that it went to the target's owner. Do not claim the recipient read it merely because
delivery succeeded. Surface neutral not-found,
recipient-unavailable, blocked, rate-limit, and history-bound refusals without guessing hidden
account or Content state.
