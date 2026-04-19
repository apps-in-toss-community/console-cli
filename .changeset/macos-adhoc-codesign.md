---
'@ait-co/console-cli': patch
---

Apply ad-hoc code signature to macOS binaries during the release build so users
can run `ait-console` on Sonoma+ without hitting Gatekeeper SIGKILL on first
launch. Adds `scripts/macos-entitlements.plist` (JIT / unsigned-executable-memory
/ disable-library-validation, required by Bun's compiled binary at runtime) and
makes `scripts/build-bin.ts` invoke `codesign --force --sign -` for any
`bun-darwin-*` target when running on a macOS host. `install.sh` now also strips
`com.apple.quarantine` and re-applies an ad-hoc signature on Darwin as a safety
net. Proper notarization is still deferred to 1.0.
