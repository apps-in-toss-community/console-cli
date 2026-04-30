# Mini-apps

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱 등록(검토 제출 포함)과 조회 endpoint 묶음. 이미지 업로드는 별도 → [`mini-app-images.md`](./mini-app-images.md). 번들/배포는 [`mini-app-bundles.md`](./mini-app-bundles.md).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app` | 워크스페이스 앱 목록 | ✅ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>` | 앱 상세 (current view) | ✅ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/with-draft` | 앱 상세 + draft (편집 진입 시) | ✅ |
| POST | `/workspaces/<wid>/mini-app/review` | 앱 등록 + 심사 제출 (원샷) | ✅ |
| POST | `/workspaces/<wid>/mini-app/pre-review` | AI 사전 검토 (옵션) | ❌ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/review-status` | 개별 앱 심사 상태 | ✅ |
| GET | `/workspaces/<wid>/mini-apps/review-status` | 워크스페이스 전체 앱 심사 상태 요약 | ✅ |

## `POST /workspaces/<wid>/mini-app/review` — 앱 등록 + 심사 제출 (원샷)

**핵심 endpoint.** 이름과 다르게 단순 review-trigger가 아니라 **create + review submission 일체형**이다. payload 완성도가 충분하면 `검토 중` 상태로 즉시 진입, 부족하면 draft 상태로 남는다. 별도의 update endpoint나 review-trigger endpoint는 존재하지 않는다.

- **Used by**: [`src/api/mini-apps.ts#createMiniApp`](../../src/api/mini-apps.ts), [`src/commands/register.ts`](../../src/commands/register.ts), [`src/commands/register-payload.ts`](../../src/commands/register-payload.ts)
- **Capture status**: ✅ confirmed (2026-04-22 dog-food, miniAppId 29349/29356/29397/29405)
- **Auth**: 세션 쿠키
- **Request headers**: `Content-Type: application/json`

### Request body

```jsonc
{
  "miniApp": {
    "title": "<app_title_ko>",
    "titleEn": "<app_title_en>",
    "appName": "<app_name>",
    "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
    "darkModeIconUri": null,
    "status": "PREPARE",
    "minAge": 19,
    "maxAge": 99,
    "csEmail": "<email>",
    "description": "<app_subtitle>",          // <= 20 code points
    "detailDescription": "<app_description>",  // <= 500 code points
    "homePageUri": "<home_page_uri>",          // optional, http(s) URL
    "images": [
      { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "THUMBNAIL", "orientation": "HORIZONTAL", "displayOrder": 0 },
      { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 1 },
      { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 2 },
      { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 3 }
    ]
  },
  "impression": {
    "keywordList": ["<keyword>", "<keyword>"],   // <= 10 entries
    "categoryIds": [3882]                         // 정수 array. {id} 객체 형태 아님
  }
}
```

**필드 메모**:

- `miniApp.iconUri`: 사전에 [`POST /resource/<wid>/upload`](./mini-app-images.md)로 업로드한 이미지 URL.
- `miniApp.images[]`: 같은 업로드 endpoint에서 받은 URL들. **최소 1개의 `THUMBNAIL/HORIZONTAL` + 최소 3개의 `PREVIEW/VERTICAL`** 이 충족돼야 즉시 검토 단계로 진입. 부족하면 draft로 남고 UI에서 추가 입력을 요구한다.
- `impression.categoryIds`: [`/impression/category-list`](./impression.md)의 `categoryList[].id`. 1개 이상 필수. 카테고리 ID에 따라 `subCategory`는 서버가 자동 결정한다 (예: `3882`("정보") 보내면 서버가 `subCategory.id: 56`("뉴스")를 자동 매핑).
- `miniApp.status`: 항상 `"PREPARE"`로 보낸다. 서버는 다른 값을 받지 않는다.
- `miniApp.minAge` / `maxAge`: 콘솔 UI 기본값 19/99 그대로. CLI도 동일.
- `darkModeIconUri`: 명시적 `null` 허용 (생략해도 됨).

### Success response (HTTP 200)

```json
{
  "ok": true,
  "workspaceId": 3095,
  "appId": 29405,
  "reviewState": null
}
```

`reviewState: null`이지만 **이게 "검토 미트리거"를 의미하지는 않는다.** payload가 완성되면 UI에서 곧바로 "검토 중이에요. 결과는 영업일 기준 2일 내 이메일로 알려드릴게요." 배너가 뜬다 (29397에서 확인). 응답이 단순히 그 필드를 채우지 않을 뿐.

내부적으로 서버는 `{ resultType: "SUCCESS", success: { miniAppId } }`를 반환하며, 위 `{ ok, workspaceId, appId, reviewState }`는 CLI(`src/commands/register.ts`)가 `--json` 출력용으로 wrap한 모양이다. raw API 형태는:

```json
{ "resultType": "SUCCESS", "success": { "miniAppId": 29397 } }
```

### Error response — server-side validation (HTTP 400, errorCode 4000)

```json
{
  "resultType": "FAIL",
  "error": {
    "reason": "<message>",
    "errorCode": "4000"
  }
}
```

확인된 server-side rules (CLI는 가능한 만큼 [`src/config/app-manifest.ts`](../../src/config/app-manifest.ts) preflight에서 잡지만 일부는 서버에서만 잡힌다):

| 필드 | 규칙 | 메시지 |
|---|---|---|
| `titleEn` | `^[A-Za-z0-9 :]+$` 만 허용 | "앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용 가능해요" |
| `detailDescription` | code point 길이 ≤ 500 | "앱 상세설명은 최대 500자를 넘어갈 수 없어요" |
| `description` (subtitle) | code point 길이 ≤ 20 | (서버 enforce 확인) |
| `appName` | apps-in-toss 전체에서 unique | (중복 시 4000) |
| `images[]` | 최소 PREVIEW/VERTICAL 3장 (검토 진입 조건) | (부족하면 draft 상태로 남음) |

### Drift history

이 endpoint는 한 번 잘못된 가설로 회귀했다가 되돌아온 이력이 있다. 새 명령을 짤 때 추측하지 않도록 요약을 남긴다:

1. **0.1.6**: `{miniApp, impression}` nested + `categoryIds: [number]`. ✅ 정답.
2. **0.1.7**: `{flat...}` + `categoryList: [{id}]`로 회귀. ❌ 4000 발생.
   - 원인: `GET /mini-app/<id>` (current view)를 draft view로 오해해 "필드가 안 들어갔다"고 판단 → payload shape 의심 → 잘못된 회귀.
3. **0.1.8**: 0.1.6 shape으로 복원. ✅ 검수 진입까지 확인 (29397, 29405).
4. 결론: **읽기는 항상 `/with-draft`로**. payload는 위 shape 그대로.

## `GET /workspaces/<wid>/mini-app` — 앱 목록

- **Used by**: [`src/api/mini-apps.ts#listMiniApps`](../../src/api/mini-apps.ts), `aitcc app ls`
- **Capture status**: ✅ confirmed
- **Auth**: 세션 쿠키
- **Response shape** (current view 기준):

```jsonc
{
  "resultType": "SUCCESS",
  "success": [
    {
      "miniAppId": 29405,
      "workspaceId": 3095,
      "appName": "<app_name>",
      "title": "<app_title_ko>",
      "titleEn": "<app_title_en>",
      "status": "PREPARE",
      "minAge": 19,
      "maxAge": 99,
      "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
      "darkModeIconUri": null,
      "homePageUri": null,
      "description": null,
      "detailDescription": null,
      "csEmail": null,
      "csContract": null,
      "csChatUri": null,
      "gameInfo": null,
      "loginClientId": null,
      "isContest": false,
      "impression": {
        "id": 0,
        "categoryList": [],
        "categoryPaths": [],
        "keywordList": [],
        "isGameCategory": false
      },
      "specialCategory": null,
      "hasHarmfulContent": false,
      "firstReleaseDate": null,
      "images": [],
      "isStatusOpen": false,
      "isGameCategory": false
    }
    // ...
  ]
}
```

**중요**: `PREPARE` 상태 앱들은 위처럼 대부분 필드가 `null`/`[]`인 채로 나타난다. 등록 시 보낸 값을 보려면 `/with-draft`를 사용해야 한다 (아래).

## `GET /workspaces/<wid>/mini-app/<mini_app_id>` — 앱 상세 (current view)

- **Used by**: [`src/api/mini-apps.ts`](../../src/api/mini-apps.ts) (`aitcc app show`의 read path 일부)
- **Capture status**: ✅ confirmed
- **Response**: 단일 앱 객체. `success`는 객체 (배열 X). shape은 위 list와 동일.

이 endpoint는 **검수 통과해 published된 마지막 상태**만 반환한다. 등록 직후 검수 전까지는 대부분 필드가 `null`. 편집/조회 목적이면 `/with-draft`를 우선해야 한다.

## `GET /workspaces/<wid>/mini-app/<mini_app_id>/with-draft` — 앱 상세 + draft

- **Used by**: 등록 직후 상태 확인. `aitcc app status` (계획), `aitcc app show --include-draft` (계획).
- **Capture status**: ✅ confirmed (2026-04-22, miniAppId 29349)
- **Response shape**:

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "current": null,                           // 검수 통과 시 위 list와 같은 단일 앱 객체
    "draft": {
      "miniApp": {
        "miniAppId": 29349,
        "workspaceId": 3095,
        "title": "<app_title_ko>",
        "titleEn": "<app_title_en>",
        "appName": "<app_name>",
        "status": "PREPARE",
        "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
        "darkModeIconUri": null,
        "homePageUri": "<home_page_uri>",
        "description": "<app_subtitle>",
        "detailDescription": "<app_description>",
        "csEmail": "<email>",
        "images": [
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "THUMBNAIL", "orientation": "HORIZONTAL", "displayOrder": 0 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 1 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 2 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 3 }
        ],
        "impression": {
          "keywordList": ["<keyword>", "<keyword>"],
          "categoryPaths": [
            {
              "group":       { "id": 7,    "name": "생활" },
              "category":    { "id": 3882, "name": "정보" },
              "subCategory": { "id": 56,   "name": "뉴스" }
            }
          ]
        }
      }
    }
  }
}
```

**핵심**: `draft.miniApp`이 등록 시 보낸 모든 필드를 그대로 들고 있다. `categoryPaths`는 서버가 `categoryIds`로부터 자동 매핑해 만든 객체 트리.

`current`는 검수 미통과 상태에서 `null`. 통과되면 위 list와 같은 단일 앱 객체.

## `GET /workspaces/<wid>/mini-app/<mini_app_id>/review-status` — 개별 앱 심사 상태

- **Used by**: [`src/api/mini-apps.ts`](../../src/api/mini-apps.ts), `aitcc app service-status` (singular path)
- **Capture status**: ✅ confirmed
- **응답**: 워크스페이스 전체 review-status의 단일 항목 형태. shape은 아래 워크스페이스-level과 동일.

> ⚠️ Plural `/mini-apps/.../user-reports` (앱 사용자 신고)와 혼동 금지. 그건 [`mini-app-misc.md`](./mini-app-misc.md)의 `app reports` endpoint다.

## `GET /workspaces/<wid>/mini-apps/review-status` — 워크스페이스 전체 앱 심사 상태 요약

> path가 **plural**(`mini-apps`)인 유일한 mini-app endpoint. 워크스페이스 전체 요약이라 plural.

- **Used by**: 콘솔 사이드바의 워크스페이스 안내. CLI에선 직접 호출 안 함 (yet).
- **Capture status**: ✅ confirmed
- **Response shape**:

```json
{
  "resultType": "SUCCESS",
  "success": {
    "hasPolicyViolation": false,
    "miniApps": [
      {
        "miniAppId": 29405,
        "title": "<app_title_ko>",
        "shutdownCandidateStatus": null,
        "scheduledShutdownAt": null,
        "serviceStatus": "PREPARE",
        "isCautionRegistered": false
      }
    ]
  }
}
```

## `POST /workspaces/<wid>/mini-app/pre-review` — AI 사전 검토 (옵션)

- **Used by**: 콘솔 UI의 "AI 사전 검토" 버튼. CLI 미구현.
- **Capture status**: ❌ not captured. payload/response 미상.
- **TODO**: dog-food 시 캡처해서 본 항목 채우기.
