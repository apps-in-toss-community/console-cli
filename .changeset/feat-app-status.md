---
"@ait-co/console-cli": patch
---

Add `aitcc app status <id>` to check the review state of a submitted mini-app, with `--watch` to poll until it flips.

The console UI shows a "검토 중이에요" banner on every submitted app's meta page. That banner isn't a single API field — it's derived from four things on the `/mini-app/:id/with-draft` envelope: `approvalType`, `current`, `rejectedMessage`, and whether a `draft` exists. `aitcc app status` encodes that derivation once so callers get a stable state string instead of reimplementing the logic.

States emitted:

- `not-submitted` — app exists but has no `approvalType` (register never called in review mode)
- `under-review` — submitted, not yet reviewed (this is the "검토 중" banner case)
- `rejected` — `rejectedMessage` is set; the CLI surfaces the reason in human output
- `approved` — the published `current` row exists, no in-flight draft
- `approved-with-edits` — approved + the editor has unpublished changes
- `unknown` — any `approvalType` we haven't observed yet (guards forward-compat)

`--watch` polls (default 60s, clamped [30, 3600]) until the state leaves `under-review`. `--json` emits NDJSON one record per tick; human mode only prints on state changes.
