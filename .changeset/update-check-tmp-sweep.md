---
'@ait-co/console-cli': patch
---

Best-effort 정리: `aitcc whoami`/`upgrade` 등의 update-check cache write 도중 SIGKILL/power-loss로 남을 수 있는 7일 이상 stale `.tmp` 파일을 다음 cache write 시 자동으로 청소합니다. 정상 동작에는 변화 없음.
