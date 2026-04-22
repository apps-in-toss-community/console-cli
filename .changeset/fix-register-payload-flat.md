---
'@ait-co/console-cli': patch
---

Fix `aitcc app register` submit payload shape based on dog-food #23 findings.

The inferred `{miniApp, impression}` wrapper silently dropped every nested
field on the server side (confirmed by round-tripping through
`GET /workspaces/:wid/mini-app`). Submit now sends a flat top-level
document matching the persisted row shape, and the `impression` block
uses `categoryList: [{id}]` instead of `categoryIds: [number]`.

Also adds two manifest validations that mirror server rules surfaced by
the dog-food: `titleEn` may contain only English letters, digits, spaces,
and colons; `description` must be at most 500 code points.

Follow-up (out of scope for this patch): the `/mini-app/review` endpoint
returns `reviewState: null`, strongly suggesting it creates a skeleton
app without triggering review. A separate `aitcc app review-request`
command will drive the trigger endpoint once captured.
