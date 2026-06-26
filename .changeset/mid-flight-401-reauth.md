---
'@ait-co/console-cli': patch
---

Add transparent mid-flight 401 reauth for read commands (`withReauthRetry`)

When a live API call fails with a genuine expired-session 401 (not a geo-block),
read-only commands now automatically re-authenticate with saved file credentials
and replay the request once — without prompting the user or opening a browser.

**What changed**

- `TossApiError` gains `isGeoBlocked` (errorCode `4010`) and `isExpiredSession`
  (`isAuthError && !isGeoBlocked`) getters, so geo-blocks are never mistaken
  for expired sessions and never trigger a reauth attempt.
- New exported `withReauthRetry<T>` helper in `_shared.ts` wraps a read
  operation: catches only `isExpiredSession` errors, loads file credentials,
  headlessly re-authenticates, and replays the call exactly once.
- Carve-outs preserved: `AITCC_SESSION` env (CI mode) and env-sourced
  credentials (`AITCC_EMAIL`/`AITCC_PASSWORD`) skip reauth and rethrow.
- Read commands wired: `whoami`, `app ls/show/status/bundles ls/bundles deployed`,
  `workspace ls/use/show/partner/terms show/segments ls`, `members ls`,
  `notices ls/show/categories`, `me terms show`, `keys ls`, `app init`
  (workspace fetch).
- Mutations are intentionally NOT wrapped (deploy, register, keys create/revoke,
  members invite/remove, workspace/me terms agree) — replaying a mutation could
  double-submit.
