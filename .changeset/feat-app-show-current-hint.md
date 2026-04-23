---
"@ait-co/console-cli": patch
---

`app show --view current` now prints a stderr hint when the current view is empty but a draft exists — the most common "why is this empty?" case for unreviewed apps. The JSON contract is unchanged (`miniApp: null` is still returned); only stderr diagnostics improve.
