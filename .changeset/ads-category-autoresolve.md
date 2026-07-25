---
"@ait-co/console-cli": patch
---

feat(ads): `app ads placement-groups create`의 `--category`를 선택 입력으로 — 비배너(전면·리워드) 포맷에서 생략 시 미니앱 자신의 category id(`impression.categoryPaths[].category.id`)를 auto-resolve하고 `in-app-ads-v2/category/:id/ad-mob-ad-info/:format`으로 검증한다. `--category`는 override로 유지. categoryPaths가 없거나 검증 실패 시 `--category` 명시를 요구하는 에러로 degrade.
