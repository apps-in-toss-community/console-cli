---
"@ait-co/console-cli": patch
---

Add `aitcc app service-status <id>` to show the server-authoritative runtime state of a mini-app.

Endpoint: `GET /mini-app/:id/review-status` (singular `mini-app` — distinct from the workspace-level `mini-apps/review-status` plural endpoint that `app ls` uses). Response: `{serviceStatus, shutdownCandidateStatus, scheduledShutdownAt}`.

This complements `app status` (which derives state client-side from `/with-draft`) by surfacing the server's canonical `serviceStatus` string — useful for detecting shutdown schedules or when the /with-draft envelope is ambiguous.
