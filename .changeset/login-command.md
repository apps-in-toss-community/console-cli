---
'@ait-co/console-cli': patch
---

`ait-console login`과 `ait-console logout`을 추가. `login`은 `127.0.0.1`의
임의 포트에 ephemeral HTTP 서버를 띄워 OAuth 콜백을 기다리고, 랜덤 `state`로
CSRF를 방지한 뒤 세션을 `0600` 권한으로 XDG 경로에 저장한다. 브라우저 자동
열기는 `--no-browser`로 끌 수 있고 (환경 변수 `AIT_CONSOLE_NO_BROWSER=1`도
동일), 콜백이 5분 안에 오지 않으면 자동으로 중단한다. 토스 개발자 콘솔의
실제 OAuth authorize URL은 아직 공개 문서가 없어 `AIT_CONSOLE_OAUTH_URL`로
오버라이드하지 않으면 사용 오류로 실패하도록 했다. `logout`은 세션 파일을
삭제하며 파일이 없을 때도 non-zero exit 없이 no-op으로 끝난다.
