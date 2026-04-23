---
"@ait-co/console-cli": patch
---

Add `aitcc workspace segments ls [--category <cat>] [--search <text>] [--page N] [--workspace <id>]` to list user segments defined in the workspace (the 세그먼트 menu).

Endpoint: `GET /workspaces/:wid/segments/list?category&search&page` — workspace-scoped (not per mini-app). Response: `{contents, totalPage, currentPage}`. `--category` defaults to "생성된 세그먼트" (the UI's initial tab). Per-segment record shape is passed through opaquely until a populated response is observed.
