---
'@ait-co/console-cli': patch
---

`aitcc upgrade`가 atomic replace 직후 새 binary로 `--version` smoke test를 수행하고, 실패하면 이전 binary로 자동 롤백한다. 새 exit code `UpgradeSmokeTestFailed` (23) 추가.
