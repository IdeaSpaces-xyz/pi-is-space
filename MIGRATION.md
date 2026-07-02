# Migration: pi-sw-space → pi-is-space

`pi-sw-space` was remote-first and exposed the old `sw_*` backend surface. `pi-is-space` is local-first: native Pi tools work on markdown files directly, while `is_*` tools cover frontmatter-aware capture and optional sync.

## Tool mapping

| Old | New |
|---|---|
| `sw_navigate` | `bash` (`find`, `rg --files`) + `read`; session awareness surfaces `_agent/` context automatically |
| `sw_search` / `sw_grep` / `sw_list_tags` | `bash` (`rg`) for local text search; semantic/local index is not exposed yet |
| `sw_read` | native `read` |
| `sw_write` | `is_write` for Notes, native `write` / `edit` for ordinary files |
| `sw_move` / `sw_delete` | `bash` (`git mv`, `rm`) |
| `sw_git` | `bash` (`git ...`) |
| `/login` + `/sw-reconnect` flow | `is_auth` for login/logout; `/is-publish` for remote hosting |

## Behavioral changes

- Tool surface is now local-capture focused: `is_write`, `is_status`, `is_commit`, `is_pull`, `is_push`, `is_auth`.
- Local markdown is the source of truth; sync is optional.
- `_agent/` awareness is assembled locally through `@ideaspaces/sdk`.
- Setup/publish flows are Pi-native commands over the CLI: `/is-setup`, `/is-publish`.
- Business logic lives in `@ideaspaces/cli` and `@ideaspaces/sdk`.

## Suggested rollout

1. Install `pi-is-space` in parallel.
2. Open a local ideaspace, or run `/is-setup` to scaffold one.
3. Validate awareness injection from `_agent/`.
4. Validate the capture loop: `is_write` into a Note, refine with returned `sha` or `is_status`, then `is_commit`.
5. Use `is_push` / `is_pull` or `/is-publish` when remote hosting is desired.
6. Keep `pi-sw-space` only as temporary fallback, then remove.
