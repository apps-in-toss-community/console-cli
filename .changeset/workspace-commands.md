---
'@ait-co/console-cli': patch
---

Add `aitcc workspace ls / use / show` for multi-tenant workspace management.

The Apps in Toss console scopes almost every resource (mini-apps, members, API keys, configs) under a workspace; an account can belong to multiple workspaces, so CLI operations need an explicit workspace context. Session schema bumps from v1 to v2 to persist `currentWorkspaceId` — v1 files are still read transparently and upgraded in-memory, then rewritten on the next explicit write.

- `aitcc workspace ls` — list workspaces the current account can access. Marks the selected one with `*`.
- `aitcc workspace use <id>` — select a workspace. Validates the id against the account's actual workspace list before persisting, so a typo fails fast instead of producing confusing 403s from every downstream command.
- `aitcc workspace show [--workspace <id>]` — dump the workspace detail (business registration / verification / review state). Pass `--workspace <id>` on `show` (and on future workspace-scoped commands) to override the persisted selection for one call without clobbering it.
- `--json` is supported on every subcommand and follows the existing exit-code contract (`ok`, `authenticated`, `reason`). Invalid id input produces `{ ok: false, reason: 'invalid-id', message }` with exit `2`; a missing workspace selection on `show` produces `{ ok: false, reason: 'no-workspace-selected' }`.
