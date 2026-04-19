---
'@ait-co/console-cli': patch
---

Use `rcodesign` (apple-platform-rs) instead of Apple's stock `codesign` to
ad-hoc sign macOS binaries during the release build. Bun-compiled binaries
have a malformed `LC_CODE_SIGNATURE` stub that stock `codesign` rejects
(`invalid or unsupported format for signature`); rcodesign handles them after
a `codesign --remove-signature` pass strips the broken stub. The
release-binaries workflow downloads the rcodesign 0.29.0 prebuilt for the
macOS runner, so no Cargo/Rust toolchain is needed at CI time. Once Bun
1.3.13+ stable lands (the upstream fix is merged in canary), this whole path
can be replaced with the stock `codesign` invocation again.
