---
'@ait-co/console-cli': patch
---

`install.sh`가 `$HOME` unset/empty/missing 환경(일부 minimal Docker, CI)에서 `/tmp/aitcc-install`로 fallback하고, GitHub Release asset 업로드 race로 인한 404를 최대 30초 exponential-backoff(1s → 2s → 4s → 8s, 8s cap)로 재시도한다. 404 외의 status는 즉시 fail해 진짜 breakage를 mask하지 않으며, retry 후에도 SHA-256 검증은 항상 수행된다.
