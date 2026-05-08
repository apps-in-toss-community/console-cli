---
'@ait-co/console-cli': patch
---

`aitcc app show`가 review lock 상태와 service status(`PREPARE`/`RUNNING`/...)를 같이 표시합니다. `--diff` 플래그로 draft와 current view를 한 번에 비교할 수 있습니다.
