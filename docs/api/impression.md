# Impression (카테고리 등)

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱 등록 시 `impression.categoryIds`에 사용할 카테고리 ID를 가져오는 reference data endpoint들.

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/impression/category-list` | 3-level 카테고리 트리 | ✅ |
| GET | `/impression/check-feature-title` | 피처 타이틀 체크 | ❌ |

## `GET /impression/category-list` — 카테고리 3-level 목록

- **Used by**: 콘솔 등록 마법사 step 2. CLI에서는 매니페스트의 `categoryIds`를 사용자가 직접 적어 넣어야 하므로 (yet) `aitcc app categories`로 노출 (TBD).
- **Capture status**: ✅ confirmed (2026-04-22)
- **Auth**: 세션 쿠키
- **Query / body**: 없음

### 트리 구조

```jsonc
{
  "resultType": "SUCCESS",
  "success": [
    {
      "categoryGroup": { "id": <int>, "name": "...", "isSelectable": <bool> },
      "categoryList": [
        {
          "id": <int>,
          "name": "...",
          "isSelectable": <bool>,
          "subCategoryList": [
            { "id": <int>, "name": "...", "isSelectable": <bool> }
          ]
        }
      ]
    }
  ]
}
```

미니앱 등록 payload의 `impression.categoryIds`에는 **`categoryList[].id`** (mid-level)만 보낸다. `subCategoryList[].id`는 직접 보내지 않으며, 서버가 카테고리 ID를 받아 자동으로 sub를 매핑한다 (예: `3882`("정보") → `subCategory.id: 56`("뉴스")).

`isSelectable: false`인 카테고리는 콘솔 UI에서 회색 처리되며 등록 시 거부될 가능성 있음 (미검증).

### 캡처된 트리 (2026-04-22)

전체 그대로 옮긴다. CLI 사용자가 매니페스트 작성 시 참고할 수 있는 single source of truth로 둔다 (수치는 redact 대상이 아님 — 공개 카테고리 ID).

#### 그룹 3 — "금융" (`isSelectable: false`)

전부 `isSelectable: false`, `subCategoryList: []`. 외부 미니앱 등록 시 선택 불가.

| ID | 이름 |
|---|---|
| 3738 | 계좌개설 |
| 3740 | 송금 |
| 3744 | ATM출금 |
| 3746 | 카드 |
| 3748 | 토스페이 |
| 3754 | 대출 받기 |
| 3756 | 신용 점수 |
| 3758 | 투자·연금 |
| 3760 | 부동산 |
| 3762 | 보험 |
| 3764 | 여행 |
| 3766 | 연금 준비 |
| 3770 | 세금 |
| 3772 | 모바일·인터넷 |
| 3774 | 내 자산 |
| 3776 | 소비 |
| 3778 | 자동차 |
| 3782 | 토스프라임 멤버십 |
| 3864 | 토스뱅크 |
| 3866 | 자녀 |
| 3870 | 결제 |

#### 그룹 5 — "게임" (`isSelectable: true`)

전부 `subCategoryList: []` (게임은 sub 없음).

| ID | 이름 |
|---|---|
| 3836 | 액션 |
| 3838 | RPG |
| 3840 | 전략 |
| 3842 | 어드벤처 |
| 3844 | 퍼즐 |
| 3846 | 시뮬레이션 |
| 3848 | 레이싱 |
| 3850 | 퀴즈 |
| 3852 | 카드 |
| 3854 | 보드 |
| 3856 | 클래식 |
| 3858 | 음악 |
| 3860 | 스포츠 |
| 3862 | 인디 |

#### 그룹 7 — "생활" (`isSelectable: true`)

| ID | 이름 | sub categories |
|---|---|---|
| 3794 | 음식 · 음료 | 84 음식 · 음료 |
| 3800 | 교육 | 82 교육 |
| 3804 | 건강 | 2 건강 관리, 4 심리, 6 운동, 8 의료, 10 영양·식단, 12 기타 |
| 3806 | 교통 | 14 자동차, 16 렌터카, 18 항공, 20 기타 |
| 3810 | 공공·행정 | 86 공공·행정 |
| 3812 | 소셜 | 92 소셜 |
| 3820 | 편의 | 76 도구, 78 구독·렌탈, 80 기타 |
| 3824 | 쇼핑 | 88 쇼핑 |
| 3830 | AI | 90 AI |
| 3832 | 비즈니스 | 22 구인구직, 24 직장, 26 사장님, 28 기타 |
| 3834 | 콘텐츠 | 62 공연·이벤트, 64 웹툰, 66 음악·오디오, 68 영상, 70 운세, 72 테스트, 74 기타 |
| 3868 | 틴즈 | (none) — `isSelectable: false` |
| 3872 | 민원 | (none) — `isSelectable: false` |
| 3876 | 결혼 | (none) — `isSelectable: false` |
| 3878 | 여행 | 30 숙박, 32 지도, 34 해외, 36 기타 |
| 3880 | 일상 | 38 가족, 40 날씨, 42 집·이사, 44 반려동물, 46 뷰티, 48 자기계발, 50 취미, 52 패션, 54 기타 |
| 3882 | 정보 | 56 뉴스, 58 도서, 60 기타 |

(sdk-example dog-food 등록은 `categoryIds: [3882]` "정보"로 진행됨.)

## `GET /impression/check-feature-title` — 피처 타이틀 체크

- **Capture status**: ❌ not captured
- 미니앱 메인 노출 시 노출되는 피처 타이틀 중복/부적절 체크로 추정. CLI 미사용.
