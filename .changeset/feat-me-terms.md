---
"@ait-co/console-cli": patch
---

Add `aitcc me terms` to show the console-level terms of agreement for the signed-in account.

Endpoint: `GET /console-user-terms/me`. This is user-scoped (sibling of `workspace terms`, which is workspace-scoped). On a fresh account the result is a single `앱인토스 콘솔 이용약관` entry with `isAgreed: true` — anyone who has logged in at all has accepted it.

Introduces a new top-level `me` command group for future account-level settings (profile, notification preferences, etc.).
