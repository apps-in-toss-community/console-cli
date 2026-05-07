---
'@ait-co/console-cli': patch
---

Add `aitcc.yaml` project context resolver: ancestor-walk loader (`findProjectContext`) and priority-chain resolver (`resolveAppContext`) that combines `--workspace`/`<appId>` flags, `AITCC_WORKSPACE`/`AITCC_APP` env vars, yaml fields, and the persisted session. No commands are wired to it yet — wiring lands in a follow-up PR.
