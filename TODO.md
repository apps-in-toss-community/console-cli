# TODO

## Notes on session schema

The current schema (`schemaVersion: 1`) stores CDP-native cookies in `cookies: CdpCookie[]`. Pre-CDP sessions written by the old OAuth-callback scaffold had `cookies: []` and no auth material, so they read back as "session exists but any live API call 401s" — the user is prompted to re-run `login`. Pre-1.0, no back-fill is needed; on `1.0` we'll bump `schemaVersion` if the shape ever changes.

## High Priority
- [ ] Implement `aitcc deploy [path]` — drive the console's deploy endpoint with the stored session. Include `--dry-run` from day one. Discovery: run `aitcc login`, then tap the console's deploy network traffic via Playwright and reproduce the request shape in `src/api/deploy.ts`.

## Medium Priority
- [ ] Implement `aitcc logs [--tail]` — scrape/stream logs from the console.
- [ ] Implement `aitcc status` — app status and last-deploy summary.
- [ ] Wire SHA-256 verification into `aitcc upgrade` — download `SHA256SUMS` from the release, verify the binary before atomic replace (currently only `install.sh` verifies). `src/commands/upgrade.ts` ~L135.
- [ ] Wire smoke test after upgrade — re-exec the new binary with `--version` before considering the upgrade successful.
- [ ] Clean up stale `<exePath>.old` files on Windows boot (currently left behind after self-upgrade).
- [ ] Audit `--json` error paths — `src/commands/upgrade.ts` writes JSON errors to stdout while plain errors go to stderr; the CLAUDE.md contract wants **diagnostics on stderr always**, with only the structured result on stdout.
- [ ] Run the first 0.1.x binary release pipeline end-to-end — exercise Changesets "Version Packages" PR → npm publish → `release-binaries.yml` matrix → `SHA256SUMS` upload → `install.sh` pull → `aitcc upgrade` roundtrip on at least one real platform.

## Low Priority
- [ ] Self-host the CLI docs (alongside the `docs` repo or as a subpath).
- [ ] Extend `install.sh` platform coverage — `/tmp` fallback when `$HOME` is unset, and exponential-backoff retry (up to 30 s) on 404 during the release-asset upload race. (`sha256sum` fallback, root-owned prior-install detection, and `AITCC_QUIET=1` are already implemented.)

## Performance
(None)

## Backlog
- [ ] OS keychain session storage (macOS Keychain / Windows Credential Manager / Secret Service) behind a flag — blocked by `bun build --compile` not bundling native deps like `keytar` cleanly across platforms. Can be added later without migrating data: move `cookies`/`origins` into the keychain, keep the rest in `session.json`.
- [ ] `aitcc mcp` — expose the same ops as an MCP stdio server. Deferred per the umbrella MCP strategy matrix.
- [ ] macOS binary signing / notarization — users currently `chmod +x` and `xattr -d com.apple.quarantine` if Gatekeeper complains. Proper notarization is a 1.0 item.
- [ ] Homebrew tap (`brew install apps-in-toss-community/tap/aitcc`).
- [ ] Plugin system, multi-account switching, release-notes generation — out of scope for 0.1.x; gated behind explicit `minor`/`major` approval.
