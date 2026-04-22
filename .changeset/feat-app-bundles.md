---
"@ait-co/console-cli": patch
---

Add `aitcc app bundles ls <id>` and `aitcc app bundles deployed <id>` to inspect upload bundles.

Endpoints:
- `GET /workspaces/:wid/mini-app/:aid/bundles[?page=&tested=&deployStatus=]` — page-based pagination, `{contents, totalPage, currentPage}`
- `GET /workspaces/:wid/mini-app/:aid/bundles/deployed` — returns the single currently-deployed bundle (or `null`)

`bundles ls` flags: `--page N`, `--tested true|false`, `--deploy-status STR` (e.g. `DEPLOYED`), plus `--workspace`, `--json`. `bundles deployed` only takes `--workspace` and `--json`.

These are the read half of the deploy surface; `aitcc deploy` (task #24) will write new bundles through a separate upload endpoint once observed. For now `app bundles ls` lets the CLI and agent-plugin see what's already there, and `app bundles deployed` answers "what version is live?" for a given app — the quickest way to confirm a deploy from the terminal.
