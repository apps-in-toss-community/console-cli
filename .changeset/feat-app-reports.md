---
"@ait-co/console-cli": patch
---

Add `aitcc app reports <id>` to list user-submitted reports (신고 내역) for a mini-app.

Endpoint: `GET /workspaces/:wid/mini-apps/:aid/user-reports?pageSize=N[&cursor=...]`. Note the **plural** `mini-apps` in the path — same split-personality as `mini-apps/review-status`. Cursor-based pagination (unlike ratings, which is page-based): the server hands back `{reports, nextCursor, hasMore}` and the caller passes `--cursor` opaquely on the next call.

Flags:

- `--page-size N` (default 20)
- `--cursor <str>` — opaque token from a previous response's `nextCursor`
- `--workspace <id>` falls through to the selected workspace
- `--json`

JSON exit codes follow the shared `app` subcommand contract (invalid-id / invalid-config → exit 2, api-error / network-error / `authenticated: false` for live failures).
