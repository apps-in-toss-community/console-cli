---
"@ait-co/console-cli": patch
---

Add `aitcc app ratings <id>` to list user ratings and reviews for a submitted mini-app.

The console UI's "평점 및 리뷰" tab is powered by `GET /mini-app/:id/app-ratings?page&size&sortField&sortDirection`. The response envelope carries `{ratings, paging, averageRating, totalReviewCount}`, so the CLI surfaces all four directly: the rollup numbers in both human and JSON output, and the per-review records (score, nickname, content, timestamp) as a tab-separated table in human mode / opaque records in JSON.

Flags:

- `--page N` (0-indexed, default 0) and `--size N` (default 20) for pagination
- `--sort-field CREATED_AT|SCORE` (default `CREATED_AT`) and `--sort-direction ASC|DESC` (default `DESC`) to match the fields the console UI emits
- `--workspace <id>` falls through to the selected workspace

JSON exit codes match the other `app` subcommands: `invalid-id` / `invalid-config` → exit 2, live API/network/auth failures follow the shared `api-error` / `network-error` / `authenticated: false` contract.
