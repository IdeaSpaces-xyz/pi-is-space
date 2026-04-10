# CLAUDE.md — pi-is-space

Pi extension for IdeaSpaces, parity with the Claude Code plugin.

## Principle

Thin wrapper only. Behavior lives in the IdeaSpaces CLI.

```
Agent (Pi) → is_* tools → IdeaSpaces CLI --json → SDK → API
```

## Tool Surface

Exactly 5 tools:
- `is_auth`
- `is_explore`
- `is_find`
- `is_read`
- `is_write`

No `sw_*` tools in this package.

## Skills

Use-case layer shipped in `skills/`:
- is-setup, is-space, is-writing, is-capture, is-reflect, is-founder, is-vc

## Development

```bash
pi install .
# or
pi -e .
```

## Migration

`pi-sw-space` is legacy naming and legacy surface (`sw_*`).
New work goes here.
