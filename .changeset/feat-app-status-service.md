---
"@ait-co/console-cli": patch
---

`app status` now surfaces the server's `serviceStatus` (PREPARE / RUNNING / …) alongside the client-derived review state, in both JSON and plain text. Also exposes `shutdownCandidateStatus` and `scheduledShutdownAt` from the same `/review-status` endpoint, so operators can see whether an approved app is actually live — or scheduled for shutdown — without making a second `app service-status` call.

`--watch` mode re-prints on either review-state OR service-status changes; the service-status call is best-effort, so a transient failure still lets the derived review state through.
