---
'@ait-co/console-cli': patch
---

`aitcc app register` now writes the returned `miniAppId` back into the resolved `aitcc.yaml`/`aitcc.json` after a successful submit, so follow-up commands like `app status` and `app deploy` resolve the same app without an explicit `--app`. YAML round-trips comments and key order; the write is a no-op when the file already pins the same id; `--dry-run` skips it; if no project file exists in the tree, a one-line stderr hint is printed instead of creating one.
