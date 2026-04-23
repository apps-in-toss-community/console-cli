---
"@ait-co/console-cli": patch
---

Add `aitcc app categories` to list the impression category tree used by `app register`'s `categoryIds` field.

Endpoint: `GET /impression/category-list` — workspace-independent lookup. Returns three groups (금융 / 게임 / 생활), each with a category list and optional sub-categories. `--selectable` collapses the output to only the entries callers may actually reference (`isSelectable: true`). Useful when authoring or validating an `aitcc.app.yaml` manifest.
