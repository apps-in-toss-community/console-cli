---
"@ait-co/console-cli": patch
---

docs: record that the console exposes no runtime-log endpoint

Full static analysis of `bootstrap.N0Zaulo0.js` (184 endpoints, 55 async
chunks, complete mini-app route table) finds zero runtime-log surface —
the three `/log/*` endpoints in the bundle are all about the **custom
analytics event catalog** (keyed on `logName`), same thing `aitcc app
events` already wraps. `aitcc app logs` is deferred until a backend log
endpoint actually exists; see `.playwright-mcp/LOGS-NOT-FOUND.md` for
the full procedure so the next attempt can pick up where this one left
off.
