# TODO

## High Priority
- [ ] Implement `ait-console login` — localhost callback OAuth flow: spawn ephemeral HTTP server on `127.0.0.1:<port>`, open the user's browser to the Toss OAuth URL with `redirect_uri=http://127.0.0.1:<port>/callback` and a random `state`, validate on callback, write session file. Pending discovery of the developer-console login URL and scopes.

## Medium Priority
- [ ] Implement `ait-console deploy [path]` — headless Playwright driving the console's deploy flow with the stored session. Include `--dry-run` from day one.
- [ ] Implement `ait-console logs [--tail]` — scrape/stream logs from the console.
- [ ] Implement `ait-console status` — app status and last-deploy summary.
- [ ] Run the first 0.1.x binary release pipeline end-to-end — exercise Changesets "Version Packages" PR → npm publish → `release-binaries.yml` matrix → `SHA256SUMS` upload → `install.sh` pull → `ait-console upgrade` roundtrip on at least one real platform.

## Low Priority
- [ ] Self-host the CLI docs (alongside the `docs` repo or as a subpath).
- [ ] Extend `install.sh` platform coverage — `sha256sum` fallback when `shasum` is missing, `/tmp` fallback when `$HOME` is unset, exponential-backoff retry on 404 during the release-asset upload race, root-owned prior-install detection, `AIT_CONSOLE_QUIET=1` mode for piped installers.

## Performance
(None)

## Backlog
- [ ] OS keychain session storage (macOS Keychain / Windows Credential Manager / Secret Service) behind a flag — blocked by `bun build --compile` not bundling native deps like `keytar` cleanly across platforms. Can be added later without migrating data: move `cookies`/`origins` into the keychain, keep the rest in `session.json`.
- [ ] `ait-console logout` — delete the session file.
- [ ] `ait-console mcp` — expose the same ops as an MCP stdio server. Deferred per the umbrella MCP strategy matrix.
- [ ] macOS binary signing / notarization — users currently `chmod +x` and `xattr -d com.apple.quarantine` if Gatekeeper complains. Proper notarization is a 1.0 item.
- [ ] Homebrew tap (`brew install apps-in-toss-community/tap/ait-console`).
- [ ] Plugin system, multi-account switching, release-notes generation — out of scope for 0.1.x; gated behind explicit `minor`/`major` approval.
