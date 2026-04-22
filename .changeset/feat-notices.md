---
"@ait-co/console-cli": patch
---

Add `aitcc notices` — read Apps in Toss notices (공지사항) from the terminal.

Subcommands:

- `aitcc notices ls [--page N] [--size N] [--search STR]` — list notices with page-based pagination and optional title substring filter
- `aitcc notices show <id>` — print a single notice (title, subtitle, category, publish time, full body) or JSON-dump it with `--json`
- `aitcc notices categories` — list the 7 category buckets with their post counts

Lives on a separate Toss service (`api-public.toss.im/api-public/v3/ipd-thor`) with a hard-coded `workspaceId=129` that's shared across every console user — there's no per-user notice bucket. Session cookies captured at login are domain-matched against `.toss.im` so they're sent automatically without any extra handshake.

New API client module at `src/api/ipd-thor.ts` so later ipd-thor surfaces (post feedback, likes, series) have a place to live. Commands/`requireSession` helper factored out of `resolveWorkspaceContext` since notices don't need a workspace id.
