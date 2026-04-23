---
"@ait-co/console-cli": patch
---

Add `aitcc workspace terms [--type TYPE] [--workspace <id>]` to show the console terms-of-agreement buckets that gate workspace-level features.

Endpoint: `GET /workspaces/:wid/console-workspace-terms/:type/skip-permission` — one call per bucket. Five types: `TOSS_LOGIN`, `BIZ_WORKSPACE`, `TOSS_PROMOTION_MONEY`, `IAA`, `IAP`. Default is to query every bucket in parallel; `--type <TYPE>` limits to a single one. Each entry is `{required, termsId, revisionId, title, contentsUrl, actionType, isAgreed, isOneTimeConsent}` — useful for checking which features are blocked by pending agreements before running commands that depend on them (e.g. `app share-rewards` needs `TOSS_PROMOTION_MONEY`, `app promotions` creation needs partner+promotion-money, etc.).
