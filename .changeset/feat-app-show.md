---
"@ait-co/console-cli": patch
---

Add `aitcc app show <id>` to surface the full mini-app detail, including fields that only live in the draft view.

`aitcc app ls` and `GET /mini-app/:id` (detail) both return the app's **current** view — the published record end users see. Until a mini-app has been reviewed and approved, `current` is empty for almost every field: no `detailDescription`, no `csEmail`, no `homePageUri`, no `images`, no `keywordList`. This is what made `aitcc app register` look buggy during dog-food (fields appeared lost). They were in the draft view all along — readable from `GET /mini-app/:id/with-draft`, which is what this new subcommand reads.

Flags:

- `--view draft` (default) — what the editor / `app register` just wrote. This is the useful view until the app is approved.
- `--view current` — the published record. Returns `miniApp: null` in `--json` when the app isn't reviewed yet, so agent-plugin can tell "unreviewed" from "reviewed and empty" apart.
- `--view merged` — current with draft overlaid on top (draft wins per field). Useful once both exist.

Human output summarises title/slug/status/home/cs/logo/subtitle + image count + keywords + category path. `--json` returns the raw `miniApp` record.

No server-mutating calls.
