---
"@ait-co/console-cli": patch
---

Add `aitcc app metrics <id>` to read conversion metrics for a mini-app.

Endpoint: `GET /workspaces/:wid/mini-app/:aid/conversion-metrics?refresh=&timeUnitType=DAY|WEEK|MONTH&startDate=&endDate=`. Defaults to the last 30 days (host local) at DAY granularity.

Flags: `--time-unit DAY|WEEK|MONTH`, `--start YYYY-MM-DD`, `--end YYYY-MM-DD`, `--refresh` (bypass server cache). Validates the date range locally (exit 2 with `invalid-date` if `start > end`).

PREPARE-state apps return `metrics: []` with a `cacheTime` ISO timestamp; per-record shape is passed through opaquely until a live-traffic response is observed.
