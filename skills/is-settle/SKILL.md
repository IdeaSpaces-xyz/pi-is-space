---
name: is-settle
description: >
  Inspect or cancel a pending active-context settle. Use when the user asks
  whether context settling is pending, says settle is stuck, or wants to cancel
  a scheduled settle before compaction finishes.
allowed-tools: "is_settle"
---

# Settle Control

`/is-settle` is the human-facing control for a pending active-context settle. It does not create a settle checkpoint; the agent-facing `is_settle` tool does that after explicit agreement.

## Commands

- `/is-settle` or `/is-settle status` — show the pending checkpoint, if any.
- `/is-settle cancel` — clear a pending settle if compaction did not run or the user changed their mind.

Use this when session switch/fork is blocked by a pending settle, or when the user asks to stop a settle before it completes.
