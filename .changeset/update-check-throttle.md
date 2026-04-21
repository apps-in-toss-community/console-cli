---
'@ait-co/console-cli': patch
---

Add a throttled update-check notice that tells users when a newer `aitcc` is available, without hammering GitHub's anonymous 60/hr rate-limit bucket.

- At most one network call every 24 hours, cached at `$XDG_CACHE_HOME/aitcc/upgrade-check.json` (or `~/.cache/aitcc/upgrade-check.json`).
- Failed checks still update the throttle window to prevent aggressive retries.
- Conditional GET with the previous ETag — a 304 response consumes no rate-limit slot.
- Fully opt-out via `AITCC_NO_UPDATE_CHECK=1`.
- The notice is skipped when stdout is not a TTY or when `--json` is passed, so agent-plugin consumers never see a stray line.
- Only runs during successful `aitcc whoami` invocations. `aitcc login` / `aitcc logout` / `aitcc upgrade` never trigger the background check.
