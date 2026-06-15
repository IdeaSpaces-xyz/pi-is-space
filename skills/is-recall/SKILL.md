---
name: is-recall
description: >
  Map, search, or excerpt the current local conversation tree when compacted
  context or prior turns may be relevant. Use after settle/compaction when the
  user asks what happened before, wants exact prior wording, or needs handles
  for checkpoints/branches without raw JSONL spelunking.
allowed-tools: "is_recall"
---

# Recall Conversation Context

Recall is the counterpart to settle: settle keeps active context small; recall deliberately retrieves relevant prior process from the local Pi session tree.

Use `is_recall` instead of reading raw JSONL files directly.

## Commands

- Map the current conversation tree:
  `is_recall({ action: "map" })`
- Search active branch:
  `is_recall({ action: "search", query: "..." })`
- Search compacted entries on active branch:
  `is_recall({ action: "search", query: "...", scope: "compacted" })`
- Excerpt an exact entry:
  `is_recall({ action: "excerpt", entryId: "..." })`
- Excerpt a range on the active branch:
  `is_recall({ action: "excerpt", fromId: "...", toId: "..." })`

## Posture

Start with `map` when you need handles. Use `search` when you know the phrase or topic. Use `excerpt` only for the small relevant piece; do not rehydrate whole compacted ranges by default.
