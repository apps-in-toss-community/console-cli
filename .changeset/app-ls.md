---
'@ait-co/console-cli': patch
---

Add `aitcc app ls` to list mini-apps in the selected workspace.

- Fetches `/workspaces/:id/mini-app` and `/workspaces/:id/mini-apps/review-status` in parallel and joins them by app id, so each row surfaces both the app identity and its review state in one call.
- Honours the workspace selection from `aitcc workspace use`; `--workspace <id>` overrides for one-off inspection.
- `--json` emits `{ ok: true, workspaceId, hasPolicyViolation, apps: [...] }`. `hasPolicyViolation` is surfaced because it is the console's workspace-wide policy flag, not a per-app attribute.
- Plain output is `appId<TAB>name<TAB>reviewState` — easy to pipe through `column -t` or `awk`. Unknown review states render as `-`; unnamed apps as `(unnamed)`.
- Mini-app payload shape is not yet fully documented (our test workspaces have zero apps); the API client normalises `id`/`name` across a few spellings and stashes the rest under `extra`. Follow-up exploration will tighten this once `sdk-example` is registered as a real mini-app.
