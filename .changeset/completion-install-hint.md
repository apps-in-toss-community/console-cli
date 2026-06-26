---
"@ait-co/console-cli": patch
---

셸 자동완성이 설치되어 있지 않을 때 최초 1회만 설치 방법을 안내하는 힌트를 추가한다. TTY 대화형 실행·알 수 없는 셸·`--json` 출력·`upgrade`/`completion` 명령에서는 항상 침묵하고, 힌트를 한 번 출력하거나 이미 설치됐음을 확인하면 마커 파일을 캐시에 남겨 두 번 다시 표시하지 않는다. rc 파일 자동 수정은 하지 않으며 사용자가 붙여넣을 수 있는 one-liner(`source <(aitcc completion bash)` / `aitcc completion zsh > …` / `aitcc completion fish > …`)만 stderr로 안내한다.
