---
"@ait-co/console-cli": patch
---

feat(telemetry): add opt-in anonymous usage telemetry client.

- New `src/telemetry/` module: `state.ts` (consent + anon_id persistence in `~/.config/aitcc/telemetry.json`), `send.ts` (fire-and-forget POST with one retry), `index.ts` (endpoint selection, first-run consent prompt, install marker).
- Events: `cli_invoked` (every command, meta: `{command}`), `cli_install` (first run after grant, meta: `{platform, arch}`).
- Consent: opt-in only. First run on TTY prompts `[y/N]`; non-TTY defaults to deny. `AITCC_TELEMETRY_ENV=staging` routes to `t-staging.aitc.dev`; dev builds (`-dev` VERSION) auto-route to staging.
- New `aitcc telemetry status/enable/disable/delete` subcommands. `delete` sends `DELETE /e?anon_id=...` and rotates local anon_id.
- Policy-version bump rule: previously-granted consent reverts to undecided when `CURRENT_POLICY_VERSION` changes (same pattern as devtools).
- 15 new unit tests (mock fetch, consent state machine, deleteMyData, retry).
- README (ko + en) updated with Telemetry section.

NOTE: metrics-ingest `source` allowlist still needs `['devtools', 'console-cli']` + `policy_version` bump — that is a separate follow-up PR on the metrics-ingest repo.
