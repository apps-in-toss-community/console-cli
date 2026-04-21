---
'@ait-co/console-cli': patch
---

Add `aitcc members ls` and `aitcc keys ls` for workspace member and API-key listing.

- `aitcc members ls [--workspace <id>]` — list workspace members, with `bizUserNo`, `name`, `email`, `status`, `role`. The `bizUserNo` is the stable per-person identifier; future member-management commands will key off it.
- `aitcc keys ls [--workspace <id>]` — list console API keys used for deploy automation. Empty lists include a stderr hint pointing users at the console UI's "발급받기" flow (issuing keys programmatically is a follow-up once we can observe the creation endpoint).
- Both commands reuse the shared workspace-context resolver added to `_shared.ts`, so `--workspace` parsing, "no workspace selected", and auth/network/api error triage are identical across `app ls` / `members ls` / `keys ls`.
- `parsePositiveInt` moved from `workspace.ts` to `_shared.ts` so every command can depend on it without importing through `workspace.ts`.
- Internal: `app ls` migrates to the shared resolver (behaviour-neutral). `keys ls --json` surfaces `needsKey: true` when the key list is empty, so agent-plugin skills can bail early with a friendly message before attempting a deploy that would 401.
- Internal: `resolveWorkspaceContext` now has unit tests covering the three failure branches (exit 10 on no session, exit 2 on invalid id, exit 2 on no selected workspace), pinning the agent-plugin JSON contract.
