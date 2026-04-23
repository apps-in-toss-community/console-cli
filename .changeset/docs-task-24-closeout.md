---
"@ait-co/console-cli": patch
---

docs: close out root-level `aitcc status` from TODO

TODO.md originally had `aitcc status [appId]` as a planned root-level
command alongside `app status`. Now that `aitcc app status <id>` is
implemented with `--watch` / `--json` / `--workspace` and fuses the
client-derived review state with the server's `serviceStatus`, the
root-level alias isn't worth the surface area: it would either
duplicate `app status` (saving 4 characters) or require a
"selected-app" mode-state the session deliberately doesn't keep.

Marks the item complete in TODO and adds a "왜 top-level `aitcc
status`가 없는가" rationale note in CLAUDE.md so future sweeps don't
re-open this question. No code changes.
