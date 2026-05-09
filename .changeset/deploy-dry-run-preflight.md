---
'@ait-co/console-cli': patch
---

`aitcc app deploy --dry-run`이 단순 echo에서 전체 사전 검증으로 강화됩니다. 번들 무결성, deploymentId 일치, workspace/app/session 컨텍스트, 권한, 약관 미동의 차단 항목을 한 번에 리포트해 라이브 deploy 전에 발화 가능한 실패를 모두 미리 잡습니다.
