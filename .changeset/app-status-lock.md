---
'@ait-co/console-cli': patch
---

`aitcc app status`가 update lock 상태를 명시적으로 surface합니다. JSON에 `locked`/`lockReason` 필드, plain mode에는 경고 줄을 추가했습니다. 권위 source는 `with-draft.success.approvalType === 'REVIEW'` — derived `state` (`approved-with-edits`/`under-review`) 만으로는 lock 해제 여부를 알 수 없습니다.
