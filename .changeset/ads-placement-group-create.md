---
"@ait-co/console-cli": patch
---

`aitcc app ads placement-groups create`를 추가했다 — 인앱광고 지면(광고 그룹)을 생성하는 mutation 명령이다. `--format BANNER|INTERSTITIAL|REWARDED`에 따라 포맷별 필수 필드(배너는 `--banner-style`, 전면·리워드는 `--category`, 리워드는 추가로 `--reward-unit`/`--reward-amount`)를 검증해 바디를 조립한다. `aitcc app iap products create`와 동일한 `--dry-run`/`--confirm` mutation 게이트를 따른다.

2026-07-24 3소스 교차 규명 결과, Toss 인앱광고는 개발자의 Google AdMob 계정 없이도 지면을 만들 수 있다 — 미디에이션 구성을 앱 카테고리 기준으로 Toss가 자동으로 한다. 생성 성공 시 발급된 `adGroupId`와 함께 "구글 등록까지 최대 2시간", "실서빙은 사업자·정산 승인 후"라는 안내, SDK 사용 힌트(`GoogleAdMob.loadAppsInTossAdMob`)를 출력한다.

전면·리워드형에 필요한 `categoryId`의 후보 목록을 반환하는 조회 API는 아직 찾지 못했다 — `--category`는 항상 필수 입력이고, 상세는 `docs/api/in-app-ads.md` "category 후보 조회 — 미해결" 참고.
