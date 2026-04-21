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
- [ ] Binary size (~60 MB on Bun 1.3.12). `--minify --sourcemap=none` is already on in `scripts/build-bin.ts` but only shaves ~2 MB — the remaining ~58 MB is the bundled Bun runtime floor. Realistic levers, from lowest to highest rewrite cost:
  - UPX-compress the release asset (~60 MB → ~20 MB). Trade-offs: ~0.5–1 s startup decompression, some AVs flag UPX binaries, and the macOS ad-hoc signature has to be reapplied AFTER `upx` (UPX rewrites the Mach-O). Worth a dedicated experimental PR once there's demand.
  - Switch runtime to Deno compile / Node SEA / @yao-pkg/pkg — all still 50–80 MB; not worth the migration.
  - Rewrite in Go / Rust / Zig — 2–5 MB binary, rewrite cost is everything. 1.0+ item.

## Backlog
- [ ] **Revisit `rcodesign` dependency** — the release pipeline downloads rcodesign 0.29.0 on every macOS job because stock `codesign` has historically rejected Bun-compiled binaries with `invalid or unsupported format for signature`. Upstream probed as of Bun 1.3.13 (2026-04-20): the regression is acknowledged in issues like [oven-sh/bun#29276](https://github.com/oven-sh/bun/issues/29276), [#29120](https://github.com/oven-sh/bun/issues/29120), [#29306](https://github.com/oven-sh/bun/issues/29306), and [#29361](https://github.com/oven-sh/bun/issues/29361) (still open). Locally on 1.3.12 + macOS 26.x, `codesign --remove-signature` followed by `codesign --sign - --force` succeeds — but only after the strip step, and robustness across all targets is unverified. Action: when a future Bun release explicitly calls out the Mach-O / LC_CODE_SIGNATURE fix in its blog, re-run the release-binaries matrix without rcodesign and delete the rcodesign install step + CLAUDE.md note.
- [ ] OS keychain session storage (macOS Keychain / Windows Credential Manager / Secret Service) behind a flag — blocked by `bun build --compile` not bundling native deps like `keytar` cleanly across platforms. Can be added later without migrating data: move `cookies`/`origins` into the keychain, keep the rest in `session.json`.
- [ ] `aitcc mcp` — expose the same ops as an MCP stdio server. Deferred per the umbrella MCP strategy matrix.
- [ ] macOS binary signing / notarization — users currently `chmod +x` and `xattr -d com.apple.quarantine` if Gatekeeper complains. Proper notarization is a 1.0 item.
- [ ] Homebrew tap (`brew install apps-in-toss-community/tap/aitcc`).
- [ ] Plugin system, multi-account switching, release-notes generation — out of scope for 0.1.x; gated behind explicit `minor`/`major` approval.
