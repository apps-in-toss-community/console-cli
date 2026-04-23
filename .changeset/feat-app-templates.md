---
"@ait-co/console-cli": patch
---

Add `aitcc app templates ls <id>` to list the smart-message composer templates for a mini-app (the template picker inside 스마트 발송).

Endpoint: `GET /mini-app/:id/templates/search?page&size&contentReachType&isSmartMessage`. Response: `{page: {totalPageCount}, groupSendContextSimpleView}` — the internal `groupSendContextSimpleView` key is renamed to `templates` at the CLI layer so the output stays readable.

Flags: `--page`, `--size`, `--content-reach-type FUNCTIONAL|MARKETING`, `--smart-message true|false`. Per-template record shape is passed through opaquely until a populated response is observed.
