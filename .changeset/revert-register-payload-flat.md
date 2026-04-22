---
"@ait-co/console-cli": patch
---

Revert the 0.1.7 "flat payload + `categoryList: [{id}]`" change for `aitcc app register`; keep the new manifest validators.

Further dog-food against workspace 3095 showed the 0.1.7 shape was a regression, not a fix. The original 0.1.6 shape (`{miniApp, impression}` wrapper + `impression.categoryIds: [number]` + `images[]` rows with `displayOrder`) is what the server actually accepts. The earlier "missing fields" signal was a read-side issue — `GET /mini-app/:id` returns only the published `current` view, so the fields we sent looked lost. `GET /mini-app/:id/with-draft` shows them all correctly persisted.

The 0.1.7 payload (flat + `categoryList`) triggers HTTP 400 on the server, so 0.1.7 is effectively broken. 0.1.8 restores working submits.

What is kept from 0.1.7: the two pre-flight manifest validators (`titleEn` may only contain English letters, digits, spaces, and colons; `description` ≤ 500 code points). Both mirror server rules surfaced during dog-food.

`/mini-app/review` is genuinely a one-shot register+submit-for-review endpoint when the payload is complete — no separate update or review-trigger endpoint exists. See `apps-in-toss-community/.playwright-mcp/FORM-SCHEMA-CAPTURED.md` ("FINAL" section) and the `xhr-captures/` directory in the umbrella for the full evidence trail.
