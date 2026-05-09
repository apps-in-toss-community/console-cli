---
'@ait-co/console-cli': patch
---

`aitcc login`이 첫 실행에서 email/password/저장 위치를 한 번에 묻는 interactive flow로 통합됐습니다. CI/script에선 `--email` + `--password-stdin`으로 동등 동작. 흩어져 있던 `aitcc auth set/clear/status`는 `aitcc login` (interactive prompt) / `aitcc logout --purge` / `aitcc whoami`로 흡수되며 deprecated 명령은 한동안 redirect로 그대로 동작합니다.
