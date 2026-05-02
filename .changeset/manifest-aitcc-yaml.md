---
'@ait-co/console-cli': patch
---

Manifest auto-detect now uses `aitcc.yaml` / `aitcc.json` (was `aitcc.app.yaml` / `aitcc.app.json`). The `.app` middle token is removed; legacy filenames are no longer recognized. Pass `--config` explicitly if you need to keep the old name.
