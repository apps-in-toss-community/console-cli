---
"@ait-co/console-cli": patch
---

`aitcc app show`/`aitcc app status`가 `GET /mini-app/:id/with-draft` 404로 실패하던 문제를 고쳤다 (업스트림 콘솔 API path drift). 읽기 경로를 같은 `GET /mini-app/:id`의 확장된 응답 shape(`miniApp` snapshot + `hasApproved`/`hasInReview`/`hasDraft`/`isBeforeFirstReview`/`approvalType`/`rejectedMessage`)으로 옮겼다. `app show`는 새 플래그를 additive JSON 필드로 노출하고, 더 이상 서버가 두 개의 독립된 draft/current payload를 주지 않아 `--diff`의 필드 단위 비교는 `diffAvailable: false` + 플래그 요약으로 낮췄다. `app status`의 `--json` 계약(`state`/`hasCurrent`/`hasDraft`/`locked`/`lockReason`/`approvalType`/`rejectedMessage`)은 그대로 유지된다.
