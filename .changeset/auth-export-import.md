---
'@ait-co/console-cli': patch
---

`aitcc auth export` / `auth import` 추가. 로컬에서 잡은 console session을 portable blob으로 dump하고 `AITCC_SESSION` env로 복원해 단발성 CI 배포에 쓸 수 있습니다. env 모드에서는 `writeSession` / `clearSession`이 no-op이라 CI 호스트에 세션 파일이 만들어지지 않습니다. **세션 쿠키는 KR-only** (한국 외 IP에선 401/`errorCode: 4010`) — GHA-hosted runner는 작동하지 않습니다. 자세한 제약은 `docs/api/auth-session.md`.
