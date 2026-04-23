---
"@ait-co/console-cli": patch
---

Add `aitcc app messages ls <id>` to list smart-message campaigns (the successor to the legacy 푸시알림 menu, now surfaced as 스마트 발송).

Endpoint: `POST /mini-app/:id/smart-message/campaigns?page=&size=` with a JSON body `{sort, search, filters}`. The unusual POST-for-list shape is what the console UI sends; the CLI mirrors it so the request is indistinguishable from XHR. Response: `{items, paging: {pageNumber, pageSize, hasNext, totalCount}}`.

Flags: `--page <n>`, `--size <n>`, `--search <text>`. Per-campaign record shape is passed through opaquely until a populated response is observed.
