---
'@ait-co/console-cli': patch
---

`aitcc app ls`가 status 컬럼을 채워 출력합니다. 검수 중인 앱은 🔒 표시 +
JSON에 `status` (`under-review` / `approved-with-edits` / `approved` /
`in-service` / `rejected` / `not-submitted` / `unknown`), `locked`,
`lockReason` 필드.
