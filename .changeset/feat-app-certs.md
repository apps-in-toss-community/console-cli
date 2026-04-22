---
"@ait-co/console-cli": patch
---

Add `aitcc app certs ls <id>` to list mTLS certificates issued for a mini-app.

Endpoint: `GET /workspaces/:wid/mini-app/:aid/certs` — a simple array. Empty `[]` is the common case (no certs provisioned); per-record shape is passed through opaquely until a populated response is observed.

Scaffolded under a `certs` group so follow-ups (`certs create`, `certs revoke`) land as sibling subcommands without reshuffling the command tree.
