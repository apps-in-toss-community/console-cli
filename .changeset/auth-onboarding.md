---
'@ait-co/console-cli': patch
---

`aitcc login` 첫 실행 시 자격 증명을 OS 키체인에 저장할지 묻는 onboarding 프롬프트를 추가하고, 사용자-facing 명령 `aitcc auth set` / `aitcc auth clear` / `aitcc auth status`를 노출한다. 프롬프트는 `--json`, 비-TTY, `--skip-onboarding`, 이미 자격 증명이 있는 경우엔 표시되지 않는다. `auth set` 비대화형 사용 시 `--password`는 `ps`/Task Manager에 노출되므로 `AITCC_PASSWORD` 환경 변수 사용을 권장하는 stderr 경고를 출력한다.
