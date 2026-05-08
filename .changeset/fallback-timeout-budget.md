---
'@ait-co/console-cli': patch
---

`aitcc login`이 headless 시도가 실패해 visible Chrome으로 fallback할 때, 첫 시도가 이미 소비한 시간을 사용자의 `--timeout` 예산에서 차감한다. 30초 minimum floor가 보장되어 짧은 timeout에서도 사용자가 폼을 채울 시간을 확보. 사용자가 `--timeout 30`으로 호출했는데 headless가 25초를 먹고 fallback해도 visible 창은 30초의 입력 시간을 받는다 (전체 명령은 요청한 timeout보다 약간 길게 실행될 수 있음).
