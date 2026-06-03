---
name: is-shape
description: >
  Shape the `_agent/` contract — create a reusable primitive (procedure,
  checklist, review pattern, memory routine) or codify a perspective (a
  repeatable thinking pattern). Use when the user wants to make how the agent
  works in a situation repeatable, or to define an evaluation/analysis they
  apply often.
allowed-tools: "is_write is_status read write edit bash"
user-invocable: true
---

# Shape the `_agent/`

Canonical protocols: read [form primitive](../../reference/form-primitive.md) for procedures, checklists, routines, and agents; read [form perspective](../../reference/form-perspective.md) for reusable thinking patterns.

## Which one

- **Primitive** — *how to work* in a situation: a procedure, checklist, review pattern, memory routine. Any part of `_agent/` with `name` + `description` frontmatter (the description is the trigger). Use [form primitive](../../reference/form-primitive.md).
- **Perspective** — *how to think* about something repeatably: an evaluation or analysis with Object Definition, Thinking Structure, Expected Outcome. Use [form perspective](../../reference/form-perspective.md).

If the user wants consistent *evaluation/analysis*, it's a perspective. If they want a repeatable *procedure/behavior*, it's a primitive.

## How

Elicit progressively — don't demand the full structure up front. Start from a real instance ("walk me through the last time you did this"), find the invariant, draft, and **show it before saving**.

Primitives and perspectives live in `_agent/` at the level where they apply; everything in `_agent/` composes along the path root → current position.

Use native `write` / `edit` for `_agent/skills/*`, `_agent/perspectives/*`, and other agent-context primitives because they use `name` + `description` frontmatter, not Note `name` + `summary` frontmatter. Use `is_write` only when shaping ordinary Notes such as `_agent/purpose.md` or `_agent/now.md` that should carry Note-style summary frontmatter.

Nothing writes without agreement — preview, confirm, then write.
