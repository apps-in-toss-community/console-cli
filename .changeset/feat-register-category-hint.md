---
"@ait-co/console-cli": patch
---

`app register` now prints a hint pointing at `aitcc app categories --selectable` whenever the manifest validator rejects `categoryIds`. The hint is plain-text only (stderr); the `--json` payload is unchanged so agent-plugin's parser stays stable.
