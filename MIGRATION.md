# Migration: pi-sw-space → pi-is-space

## Tool mapping

| Old | New |
|---|---|
| `sw_navigate` | `is_explore` |
| `sw_search` / `sw_grep` / `sw_list_tags` | `is_find` |
| `sw_read` / `sw_git(log --path)` | `is_read` |
| `sw_write` / `sw_move` / `sw_delete` | `is_write` |
| `/login` + `/sw-reconnect` flow | `is_auth` |

## Behavioral changes

- Interface is consolidated to 5 tools.
- Extension is thin CLI wrapper; business logic lives in CLI.
- Skill pack is use-case oriented (`is-setup`, `is-founder`, etc.).

## Suggested rollout

1. Install `pi-is-space` in parallel.
2. Run `is_auth action="status"` and reconnect with `is_auth` if needed.
3. Validate read/write/search flows in an existing space.
4. Switch prompts and docs from `sw_*` to `is_*` names.
5. Keep `pi-sw-space` only as temporary fallback, then remove.
