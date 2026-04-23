---
"@ait-co/console-cli": patch
---

Add `aitcc app events ls <id>` to list the custom event catalogs (log search) for a mini-app — the 이벤트 menu in the console.

Endpoint: `POST /mini-app/:id/log/catalogs/search` with body `{isRefresh, pageNumber, pageSize, search}`. Response: `{results, cacheTime, paging: {pageNumber, pageSize, hasNext, totalCount, totalPages}}`. PREPARE-state apps return an empty `results` with a server-cache timestamp — same pattern as `conversion-metrics`.

Flags: `--page <n>`, `--size <n>`, `--search <text>`, `--refresh` (bypass server cache). Per-event record shape is passed through opaquely until a populated response is observed.
