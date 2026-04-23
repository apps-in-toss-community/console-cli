---
"@ait-co/console-cli": patch
---

Add `aitcc app share-rewards ls <id>` to list share-reward promotions for a mini-app.

Endpoint: `GET /workspaces/:wid/mini-app/:aid/share-rewards?search=` — a simple array. The console UI always sends `search=` (empty matches everything); the CLI mirrors that shape so the request is indistinguishable from the UI's XHR.

Flag: `--search <text>` for a title-contains filter. Per-record shape is passed through opaquely until a populated response is observed.
