---
name: is-orient
description: >
  Orient inside an ideaspace. Use at session start when orientation is missing,
  when the user asks "where are we?", "what are we doing?", "what changed?",
  or when context feels unclear. Uses the injected awareness map as the first
  bounded overview; does not modify files.
allowed-tools: "is_navigate is_inspect is_status read bash"
---

# Orient

Orient is the first conscious step after arrival: understand the place before acting.

Pi already injects an `[IdeaSpaces Awareness]` map with the position's composed agreement and current-state summaries. Treat that map as the first disclosure rung, not as a list of files to reload.

## Start from awareness

For a basic orientation question, answer directly from the injected map. It normally already carries the active purpose, current work, tree summaries, operating skills, and working-set handles.

Stop as soon as the user's question is answered:

- Do not reread contract, current-state, or README files whose summaries are represented in awareness.
- Do not follow links during basic orientation.
- Do not inspect git history, diffs, code, or implementation evidence unless the user asks what changed, needs pending-work detail, or asks to verify a status claim.

## Deepen only when needed

1. Use `is_navigate` when the requested position is not the current focus or the map needs a bounded tree probe. Navigation changes awareness; it does not justify loading document bodies.
2. Use `is_status` when capture or git state materially affects the answer.
3. For change questions, inspect only the relevant `git status` or short recent history.
4. Use `is_inspect` only when one document needs deeper attention: start with its summary when the map does not already represent it, then request an outline before one exact section. Do not cascade through links.
5. Use native `read` only when exact full-document or implementation evidence is required, such as verifying whether documented work actually shipped.

Answer with the active purpose, current work, relevant pending changes, and drift signals needed to make the next action obvious. Keep orientation compact rather than turning it into an audit.

## Posture

- Missing named `_agent/` files are drift signals, not errors.
- Awareness summaries are handles for deeper inspection, not permission to preload their sources.
- When deeper evidence is necessary, say what ambiguity or verification need caused the step down the ladder.

## Next intents

- If the user wants to preserve understanding → **is-capture**.
- If the user wants to push/share state → **is-push**; to pull/get the latest → **is-pull**.
- If the agreement no longer matches reality → **is-reflect**.
- If the user wants to change how agents work here → **is-shape**.
