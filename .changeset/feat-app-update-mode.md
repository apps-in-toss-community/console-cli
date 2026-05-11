---
'@ait-co/console-cli': patch
---

feat(register): wire manifest `miniAppId` into update-mode payload

The server `POST /workspaces/:wid/mini-app/review` endpoint already runs
dual-mode (absent `miniApp.miniAppId` → create, present → update existing
draft and re-enter review queue) per `docs/api/mini-apps.md`. The CLI side
was hardcoded to create-only: yaml `miniAppId: 31146` was parsed and
write-back-eligible but never forwarded into the submit body.

Changes:
- `AppManifest.miniAppId?: number` validated as positive integer; `null`
  treated as absent (create mode).
- `MiniAppSubmitPayload.miniApp.miniAppId?: number` threaded through
  `buildSubmitPayload` only when manifest provides it.
- `aitcc app register` prints `[mode: update · miniAppId N] existing app
  draft will be overwritten and re-enter the review queue.` to stderr in
  non-JSON mode so the operator knows they are updating, not creating.

Verified against 31146 with `--dry-run --json`: payload now includes
`"miniAppId":31146` (previously absent). Closes the reject → re-asset →
resubmit feedback loop without the console web UI detour.
