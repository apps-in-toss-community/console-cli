---
'@ait-co/console-cli': patch
---

Add `aitcc app certs show <certId>` to surface a single mTLS cert's metadata in one round-trip — derives `daysUntilExpiry` (D-N or "expired N day(s) ago") so agents can verify expiry without parsing `app certs ls` output. The console has no per-cert detail endpoint, so this reuses the list fetch with client-side filter; PEM material is never on list responses. `export` is intentionally not added — the console only emits PEM at issue time and exposes no re-download path. If you lost the `--out` backup, `revoke` + `issue` to roll a new cert.
