---
name: is-cleanup
description: >
  Preview, inspect, apply, or cancel active-context cleanup. Use when context is
  cluttered, the user asks to clean up/compact the conversation, or a natural
  boundary is reached and raw process can leave active context while
  remaining recallable.
allowed-tools: "is_cleanup"
---

# Cleanup Active Context

Cleanup is workshop cleanup for the active conversation window. It does not change shared understanding. **Capture** is the agreement moment; **cleanup** keeps the bench usable.

The current implementation is **active-window cleanup**: sliding-window compaction where older raw turns leave active context, while the checkpoint/keep/drop plan stays live. When continuity matters, set `tailTurns` to keep that many recent user-started turns exact after cleanup. The tail is resolved when cleanup applies; turns added after preview can shift the kept tail forward. Exact older turns remain recoverable through `/tree` and **is-recall**.

Cleanup builds on Pi-native session primitives: it writes a normal compaction entry, labels cleanup anchors for `/tree`, and provides deterministic cleanup-aware branch summaries when `/tree` navigation leaves a cleaned branch. Arbitrary middle-range/chunk cleanup is still not first-class yet; `tailTurns` is the simple timeline knob.

## Commands

- Preview a cleanup plan:
  `is_cleanup({ action: "preview", scope: "active-window", checkpoint: "...", keep: "...", drop: "...", tailTurns: 4 })`
- Apply after the user confirms:
  `is_cleanup({ action: "apply", scope: "active-window", checkpoint: "...", keep: "...", drop: "...", tailTurns: 4 })`
- `/is-cleanup` or `/is-cleanup status` — show the pending cleanup, if any.
- `/is-cleanup cancel` — clear a pending cleanup if compaction did not run or the user changed their mind.

## Posture

Prefer preview before apply. The preview should say:

- how many recent user-started turns will stay exact (`tailTurns`), if any
- what will stay live as checkpoint / bench items
- what will leave active context
- rough current context and branch-entry count at preview time
- that raw history remains recallable
- that cleanup anchors will be labeled in `/tree`
- that post-cleanup footer usage is known after compaction / next model response

Apply only after the user confirms the cleanup plan or explicitly asks to clean up now.

After cleanup completes, use **is-recall** / `is_recall` to map, search, or excerpt compacted conversation context.
