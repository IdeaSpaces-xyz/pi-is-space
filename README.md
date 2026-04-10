# pi-is-space

Pi extension for [IdeaSpaces](https://ideaspaces.xyz) with the same 5-tool interface as the Claude Code plugin.

## Why this exists

`pi-is-space` is parity-mode:

- same tool surface: `is_auth`, `is_explore`, `is_find`, `is_read`, `is_write`
- same behavior model: thin wrapper that shells out to `ideaspaces --json`
- same skills: setup, writing, capture, reflect, founder, vc

Architecture:

```txt
Agent (Pi) → pi-is-space (thin extension) → IdeaSpaces CLI --json → SDK → API
```

## Install

```bash
pi install /path/to/pi-is-space
# or run without installing
pi -e /path/to/pi-is-space
```

## Tools

| Tool | What |
|---|---|
| `is_auth` | Login, logout, list spaces, connection status |
| `is_explore` | See tree structure, branch context, and orientation |
| `is_find` | Find by meaning (`search`), text (`grep`), or metadata (`list`) |
| `is_read` | Read content + metadata, optional history |
| `is_write` | Create, update, move, or delete notes |

## Auth

Run `is_auth` (default action is login). Browser OAuth opens, credentials are stored by the CLI.

You can also check status via:

- `is_auth action="status"`
- `is_auth action="repos"`

See also: `MIGRATION.md` for mapping from `pi-sw-space`.

## Skills

- `is-setup`
- `is-space`
- `is-writing`
- `is-capture`
- `is-reflect`
- `is-founder`
- `is-vc`
