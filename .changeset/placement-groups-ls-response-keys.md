---
'@ait-co/console-cli': patch
---

`app ads placement-groups ls`의 휴먼 출력이 실제 응답 키를 읽도록 수정 — 지면마다 식별자와 상태가 `-`로 죽던 문제(#240)

렌더러가 `id`/`status`를 읽었지만 응답의 키는 `groupId`/`state`다. `--json`은 응답을 그대로 흘려보내므로 영향이 없었고, 그래서 무증상으로 남아 있었다. 컬럼 헤더(`GROUP ID / NAME / STATE`)를 추가하고, 키 계약을 고정하는 유닛 테스트를 넣었다.

`placement-groups create`는 더 이상 `상태: REGISTERING`을 인쇄하지 않는다 — 서버가 확인해 준 적 없는 값이었다. 출처가 있는 "구글 반영까지 최대 2시간" 안내만 남기고, 실제 상태는 `ls`로 확인하도록 가리킨다.
