---
name: is-conversation
description: >
  Name, describe, or inspect the current local conversation flow. Use when the
  user asks what conversation/thread/flow this is, wants to name it, or wants a
  short description attached to the private Pi JSONL session overlay.
allowed-tools: "is_conversation"
---

# Conversation Flow

A conversation is the local flow where understanding forms before some of it becomes captured Space state. `is_conversation` indexes Pi's existing JSONL session with a stable local conversation id, name, and description. It does not move, publish, or sync raw conversation logs.

## Use

- Show current flow: `is_conversation({ action: "status" })`
- Name the flow: `is_conversation({ action: "name", name: "..." })`
- Describe the flow: `is_conversation({ action: "describe", description: "..." })`

## Posture

Keep names short and human. Descriptions should say what this flow is for and what kind of work is happening here, not summarize every turn.

For settled understanding, use **is-capture**. After meaningful capture, consider **is_settle** only with explicit user agreement.
