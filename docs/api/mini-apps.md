# Mini-apps

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱 등록(검토 제출 포함)과 조회 endpoint 묶음. 이미지 업로드는 별도 → [`mini-app-images.md`](./mini-app-images.md). 번들/배포는 [`mini-app-bundles.md`](./mini-app-bundles.md).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app` | 워크스페이스 앱 목록 | ✅ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>` | 앱 상세 — single snapshot(`miniApp`) + summary flags(`hasApproved`/`hasInReview`/`hasDraft`/`isBeforeFirstReview`). `app show`/`app status`의 주 read path (2026-07-23~) | ✅ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/with-draft` | ~~앱 상세 + draft (편집 진입 시)~~ — **404 (issue #219, 2026-07-23 확인)**. 위 plain path로 대체됨 | ❌ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/draft` | draft 전용 조회 | ⚠️ (존재는 확인, populated shape 미보유) |
| POST | `/workspaces/<wid>/mini-app/review` | 앱 등록 + 심사 제출 (원샷) — `miniApp.miniAppId` 포함 시 update mode | ✅ |
| POST | `/workspaces/<wid>/mini-app/pre-review` | AI 사전 검토 (옵션) | ❌ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/review-status` | 개별 앱 심사 상태 | ✅ |
| GET | `/workspaces/<wid>/mini-apps/review-status` | 워크스페이스 전체 앱 심사 상태 요약 | ✅ |
| DELETE | `/workspaces/<wid>/mini-app/<mini_app_id>` | 앱 삭제 (route는 존재, OWNER 세션엔 막힘) | 🚫 |

## `POST /workspaces/<wid>/mini-app/review` — 앱 등록 + 심사 제출 (원샷, dual-mode)

**핵심 endpoint.** 이름과 다르게 단순 review-trigger가 아니라 **create + review submission 일체형**이다. payload 완성도가 충분하면 `검토 중` 상태로 즉시 진입, 부족하면 draft 상태로 남는다. 별도의 review-trigger endpoint는 존재하지 않는다.

**Dual mode** (2026-05-01 dog-food로 확정):

- `miniApp.miniAppId` **부재 → create**. 새 미니앱이 만들어지고 응답 `success.miniAppId`에 새 id가 담긴다.
- `miniApp.miniAppId` **존재 → update**. 그 id의 기존 미니앱의 draft를 덮어쓰고 review 큐로 보낸다. 응답 `success.miniAppId`엔 같은 id가 그대로 돌아온다.

별도 PUT/PATCH endpoint는 존재하지 않는다 — 콘솔 번들(`bootstrap.*.js`)에 mini-app 경로의 PUT/PATCH 호출이 하나도 없고, react-router method enum 외에는 string literal로도 등장하지 않는다. 콘솔의 `/mini-app/<id>/meta/edit` UI도 form 제출 시 동일하게 이 endpoint로 `miniAppId` 포함 POST를 보낸다. update mode의 자세한 동작·제약은 [Update mode 섹션](#update-mode-2026-05-01-확정) 참조.

- **Used by**: [`src/api/mini-apps.ts#createMiniApp`](../../src/api/mini-apps.ts), [`src/commands/register.ts`](../../src/commands/register.ts), [`src/commands/register-payload.ts`](../../src/commands/register-payload.ts)
- **Capture status**: ✅ confirmed (dog-food: 29349/29356/29397/29405 @ 2026-04-22, 31146 @ 2026-05-03 final)
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

### Server raw response (HTTP 200)

서버가 wire 위에서 실제로 보내는 형태:

```json
{ "resultType": "SUCCESS", "success": { "miniAppId": 29397 } }
```

표준 envelope의 `success` 안에 `miniAppId` 하나만. 다른 필드는 없다. 응답이 검수 진입 여부를 직접 알려주지 않으므로, 등록 직후 상태를 알고 싶으면 [`GET /mini-app/<mini_app_id>`](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot) 또는 [`/review-status`](#-get-workspaceswidmini-appmini_app_idreview-status--개별-앱-심사-상태)를 별도 호출한다 (UI도 그렇게 동작). (2026-07-23 이전엔 `/with-draft`를 가리켰으나 해당 경로는 404 — 아래 "Drift history" 5번 참조.)

### CLI `--json` output

[`src/commands/register.ts`](../../src/commands/register.ts)는 위 raw 응답을 unwrap한 뒤 자체 형식으로 다시 wrap해서 stdout으로 출력한다:

```json
{
  "ok": true,
  "workspaceId": 3095,
  "appId": 29405,
  "reviewState": null
}
```

`reviewState: null`이지만 **이게 "검토 미트리거"를 의미하지는 않는다.** payload가 완성되면 UI에서 곧바로 "검토 중이에요. 결과는 영업일 기준 2일 내 이메일로 알려드릴게요." 배너가 뜬다 (29397에서 확인). CLI 응답이 단순히 이 필드를 채우지 않을 뿐 — 서버 응답에도 review 상태는 포함되지 않으므로 필요하면 `app service-status`로 따로 조회한다.

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

| 필드 | 규칙 | 메시지 / errorCode |
|---|---|---|
| `title` (titleKo) | 한글/영문/숫자/공백/`:`/`·`/`?`만, **공백 제외 ≤ 10 code points** | `errorCode: miniApp.InvalidTitle` |
| `titleEn` | `^[A-Za-z0-9 :·?]+$`, **공백 제외 ≤ 15 code points**, AND **각 단어 title-case 강제** (uppercase first char + lowercase tail; `AITC` / `SDK` 같은 all-caps 거부, `Aitc Sdk Example` ✅) | `errorCode: miniApp.InvalidTitleEn` ("앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용 가능해요" 메시지는 정규식 위반 시) |
| `detailDescription` | code point 길이 ≤ 500 | "앱 상세설명은 최대 500자를 넘어갈 수 없어요" |
| `description` (subtitle) | code point 길이 ≤ 20 | (서버 enforce 확인) |
| `appName` | apps-in-toss 전체에서 unique | (중복 시 4000) |
| `images[]` | 최소 PREVIEW/VERTICAL 3장 (검토 진입 조건) | (부족하면 draft 상태로 남음) |

`title` / `titleEn` 길이·case 규칙은 sdk-example#39 등록 시 발견 (2026-05-03). errorCode는 prefix 형태 (`miniApp.InvalidTitle` / `miniApp.InvalidTitleEn`) — 다른 도메인의 숫자형 errorCode (`4000` / `4046` 등)와 다른 패턴이다.

### Drift history

이 endpoint는 한 번 잘못된 가설로 회귀했다가 되돌아온 이력이 있다. 새 명령을 짤 때 추측하지 않도록 요약을 남긴다:

1. **0.1.6**: `{miniApp, impression}` nested + `categoryIds: [number]`. ✅ 정답.
2. **0.1.7**: `{flat...}` + `categoryList: [{id}]`로 회귀. ❌ 4000 발생.
   - 원인: `GET /mini-app/<id>` (current view)를 draft view로 오해해 "필드가 안 들어갔다"고 판단 → payload shape 의심 → 잘못된 회귀.
3. **0.1.8**: 0.1.6 shape으로 복원. ✅ 검수 진입까지 확인 (29397, 29405).
4. (당시 결론, 2026-05-01~2026-07-22 유효했음): **읽기는 `/with-draft`로**. payload는 위 shape 그대로.
5. **issue #219 (2026-07-23)**: 위 결론이 깨짐 — `GET /mini-app/<mini_app_id>/with-draft`가 **404**로 전환됐다(업스트림 콘솔 API path drift, `app ls`/`service-status`/`workspace terms` 등 다른 경로는 영향 없음). 대체 경로는 plain `GET /mini-app/<mini_app_id>` — 같은 path인데 응답 envelope이 `{miniApp, isBeforeFirstReview, hasApproved, hasInReview, hasDraft}`로 확장됐다 (구 `current`/`draft` 두 record 대신 단일 `miniApp` snapshot + summary flags). `app show`/`app status`는 이 새 shape으로 마이그레이션했고, draft-vs-current 필드 단위 비교(`app show --diff`)는 더 이상 서버가 두 개의 독립된 payload를 안 주므로 `diffAvailable: false`로 격하됐다. 상세 캡처는 아래 새 섹션 참조.

### Update mode (2026-05-01 확정)

create payload에 `miniApp.miniAppId`를 추가하면 update mode가 된다. 같은 endpoint, 같은 payload shape — `miniAppId` 한 필드 유무로 분기.

#### 동작 (`approvalType` 별)

`approvalType`은 envelope의 `success.approvalType` (앱 객체 내부 X). 2026-07-22까지는 `/with-draft` 응답의 `success`에서 직접 읽었고, 그 경로가 404가 된 이후(issue #219)로는 [`GET /mini-app/<mini_app_id>`](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot-2026-07-23) 응답의 `success.approvalType`이 같은 위치(여전히 flat, `miniApp` 형제 필드)에서 같은 역할을 한다.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> REVIEW: create<br/>(POST /mini-app/review,<br/>no miniAppId)
    REVIEW --> APPROVED: ops review<br/>(통과)
    REVIEW --> REJECTED: ops review<br/>(반려<br/>+ rejectedMessage)
    APPROVED --> REVIEW: update<br/>(~3s 비동기,<br/>current 유지)
    REJECTED --> REVIEW: update<br/>(즉시,<br/>draft 덮어씀)
    REVIEW --> REVIEW: update<br/>❌ errorCode 4046<br/>(잠금)

    note right of REVIEW
        사용자 측 큐 회수 불가
        (review-withdraw endpoint 부재)
    end note
```

> 자가 전이 `REVIEW → REVIEW`는 실제 상태 변경이 아니라 update 호출이 차단됨을 표현 (HTTP 200 + envelope FAIL).

| 시작 상태 | update 결과 | 동작 |
|---|---|---|
| `APPROVED` (검수 통과, 출시 전/후 무관) | `APPROVED` → `REVIEW` (~3초 지연, 비동기) | `current` (live published, 출시된 경우 사용자 노출) **유지**. 새 변경은 `draft`로 들어가고 `approvalType`이 REVIEW로 flip. live 사용자 영향 없음. 운영팀이 새 draft를 검수 → 통과 시 `current`가 새 내용으로 갱신. |
| `REJECTED` | `REJECTED` → `REVIEW` (즉시) | `current` 없음. `draft`만 존재. update payload가 `draft`를 덮어쓰고 review 큐로 진입. |
| `REVIEW` | ❌ HTTP 200 + `errorCode: 4046` | "검수중인 요청이 있어 검수요청을 할 수 없어요." 운영팀이 검수 결과를 내야 잠금 해제. **사용자가 직접 큐에서 빼는 방법 없음** — `mini-app/review-withdraw` 같은 endpoint는 존재하지 않는다 (콘솔 번들에 `bundles/reviews/withdrawal`, `templates/.../review/withdraw`, `smart-message/.../review-withdraw` 등 다른 도메인 withdraw는 있지만 `mini-app/.../review-withdraw`는 없음). |

#### Update payload (29397 dog-food, 2026-05-01 캡처)

```jsonc
// POST /workspaces/3095/mini-app/review
{
  "miniApp": {
    "miniAppId": 29397,                   // ← presence triggers update mode
    "title": "<app_title_ko>",
    "titleEn": "<app_title_en>",
    "appName": "<app_name>",
    "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
    "darkModeIconUri": null,
    "status": "PREPARE",                   // create와 동일하게 항상 "PREPARE"
    "minAge": 19,
    "maxAge": 99,
    "csEmail": "<email>",
    "description": "<app_subtitle>",
    "detailDescription": "<app_description>",
    "homePageUri": "<home_page_uri>",
    "images": [/* 기존 images 배열 그대로 */]
  },
  "impression": {
    "keywordList": ["<keyword>", ...],
    "categoryIds": [3882]                  // categoryPaths 객체 트리가 아니라 정수 array
  }
}
```

#### Update payload 작성 패턴

콘솔 UI의 `/mini-app/<id>/meta/edit` form은 background save XHR 없이 submit 시점에 form state 전체를 그대로 보낸다. 외부에서도 동일 패턴: **읽어온 `miniApp` + `impression`을 그대로 떠다 변경 필드만 덮어 보낸다.** (2026-07-22까지는 `/with-draft` 응답의 `draft ?? current`에서 떠 왔고, 그 경로가 404가 된 이후로는 [`GET /mini-app/<mini_app_id>`](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot-2026-07-23) 응답의 단일 `miniApp`에서 뜬다 — 어느 쪽이든 떠오는 `miniApp`/`impression`의 shape 자체는 동일.) 부분 update(특정 필드만 보내기)는 미검증 — 안전하게 풀 payload로 보내라.

`impression.categoryIds`는 응답엔 없는 필드라 만들어야 한다 — `impression.categoryPaths[].category.id`를 모아서 array로:

```js
const categoryIds = source.impression.categoryPaths.map(p => p.category.id);
```

##### Payload 함정 (2026-05-02 재현 확인)

서버는 정확한 shape에 까다롭다. 실측한 두 가지 reject 케이스:

- **`miniApp.impression`은 stripped해야 한다.** `/with-draft` 응답의 `success.draft.miniApp`에는 `impression` nested object가 들어있지만(read-side convenience), update payload에 그대로 두면 envelope의 `{miniApp, impression}` 래퍼와 충돌해 `errorCode: 4000` "잘못된 요청입니다." 또는 "카테고리는 2개 이상 설정할 수 없어요." 로 거부된다.
- **`categoryIds`는 leaf 한 단계 위(`category.id`)까지만.** `subCategory.id`(예: 56 = "뉴스")를 넣으면 `errorCode: null`, `reason: "카테고리 정보가 없음: <id>"`로 거부. 즉 트리 leaf가 아니라 mid-level만 허용. `categoryPaths[].category.id` (예: 3882 = "정보") 가 정답.

##### REVIEW lock 권위 — `app status` state 값 vs `approvalType`

`aitcc app status <id>`의 `state: approved-with-edits` 같은 derived 라벨은 **REVIEW lock 해제 여부의 권위가 아니다**. 2026-05-02 dog-food: 4개 앱이 각각 `approved-with-edits`(29349/29356) / `under-review`(29397/29405)로 보였지만 update 호출 결과 **4개 모두 `errorCode: 4046`**. 권위는 `approvalType` 한 곳뿐 — 그 값이 `REVIEW`이면 lock. CLI가 lock 추정으로 분기하지 말고 항상 시도해서 4046을 받는 패턴이 안전하다.

> **경로 갱신 (issue #219, 2026-07-23)**: 이 `approvalType`을 읽던 endpoint가 바뀌었다. 2026-07-22까지는 `with-draft.success.approvalType`(envelope-level)이었으나, 그 경로가 404가 된 뒤로는 [`GET /mini-app/<mini_app_id>`](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot-2026-07-23) 응답의 `success.approvalType`이 같은 권위를 대신한다 — **`miniApp` 안으로 옮겨간 게 아니라 여전히 `miniApp`의 형제 필드**다(위 새 섹션의 "핵심" 첫 항목 참조). 값 자체의 의미(`REVIEW`=lock)는 변하지 않았다.

`aitcc app status`가 이 권위 신호를 직접 surface한다: JSON 모드에 `locked: boolean` + `lockReason: 'review-pending' | null`, plain 모드에 locked일 때 `⚠️ update locked` 한 줄. 다른 lock 사유는 현재 미발견 — 새 값 발견 시 `LockReason` union 확장.

#### Response

```json
// HTTP 200
{ "resultType": "SUCCESS", "success": { "miniAppId": 29397 } }
```

create와 같은 shape. 응답이 update vs create인지 구분해 알려주지 않는다 — 호출자가 자기 의도로 안다.

REVIEW 잠금 시:

```json
// HTTP 200 (envelope FAIL)
{
  "resultType": "FAIL",
  "success": null,
  "error": {
    "errorType": 0,
    "errorCode": "4046",
    "reason": "검수중인 요청이 있어 검수요청을 할 수 없어요.",
    "data": {},
    "title": null
  }
}
```

#### CLI 영향

CLI는 아직 update mode를 노출하지 않는다 (`aitcc app register`는 항상 create). update를 다루려면 별도 명령(`aitcc app update`?)이 필요하고, REVIEW 잠금 시 `errorCode: 4046`을 어떻게 사용자에게 surface할지 결정해야 한다 — 현재 `src/api/http.ts`는 `4010`만 `isAuthError`로 별도 처리, 나머지는 generic `TossApiError`. backlog.

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

**중요**: `PREPARE` 상태 앱들은 위처럼 대부분 필드가 `null`/`[]`인 채로 나타난다. 등록 시 보낸 값을 보려면 아래 [`GET /mini-app/<mini_app_id>`](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot-2026-07-23)를 사용해야 한다 (2026-07-22까지는 `/with-draft`였음 — 아래 "Drift history" 5번).

## `GET /workspaces/<wid>/mini-app/<mini_app_id>` — 앱 상세 (single snapshot, 2026-07-23~)

- **Used by**: [`src/api/mini-apps.ts#fetchMiniAppDetail`](../../src/api/mini-apps.ts), `aitcc app show`, `aitcc app status`, `aitcc app ls` (per-app fan-out for review state).
- **Capture status**: ✅ confirmed (2026-07-23, workspace 3095 / miniAppId 31146, `APPROVED` / no pending draft — issue #219 fix)
- **Response shape** (fields we actually read; the server also re-flattens most of `miniApp`'s own fields directly onto `success` as duplicates — that duplication is ignored, not documented field-by-field):

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "isBeforeFirstReview": false,
    "hasApproved": true,
    "hasInReview": false,
    "hasDraft": false,
    // Flat siblings of `miniApp` below — NOT nested inside it. This is the
    // one field placement easy to get wrong (see callout below the shape).
    "approvalType": "APPROVED",      // "APPROVED" | "REVIEW" | "REJECTED" — same authority as the old with-draft envelope-level field, still flat here.
    "rejectedMessage": null,          // approvalType === "REJECTED"일 때만 string.
    "draft": null,                    // 관찰상 always null so far when hasDraft:false — populated shape not yet captured (미검증).
    "review": null,                   // 미검증 — 검수 이력 record로 추정.
    "savedAt": null,
    "datingCheckListPdfUrl": null,
    "miniApp": {
      "miniAppId": 31146,
      "workspaceId": 3095,
      "appName": "<app_name>",
      "title": "<app_title_ko>",
      "titleEn": "<app_title_en>",
      "status": "PREPARE",           // 항상 "PREPARE" — published 여부는 firstReleaseDate로 판단.
      "minAge": 19,
      "maxAge": 99,
      "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
      "darkModeIconUri": null,
      "homePageUri": "<home_page_uri>",
      "description": "<app_subtitle>",
      "detailDescription": "<app_description>",
      "csEmail": "<email>",
      "csContract": null,
      "csChatUri": null,
      "gameInfo": null,
      "appType": "NON_GAME",
      "loginClientId": null,
      "isContest": false,
      "impression": {
        "id": 17645,
        "categoryPaths": [
          {
            "categoryGroup": { "id": 7, "name": "생활", "isSelectable": true, "isGameCategory": false },
            "category":       { "id": 3882, "name": "정보", "isSelectable": true },
            "subCategory":    { "id": 56, "name": "뉴스", "isSelectable": true },
            "isGameCategory": false
          }
        ],
        "keywordList": ["<keyword>", "<keyword>"]
      },
      "specialCategory": null,
      "hasHarmfulContent": false,
      "firstReleaseDate": null,       // null = 한 번도 출시 안 함.
      "images": [
        { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "THUMBNAIL", "orientation": "HORIZONTAL", "displayOrder": 0, "backgroundColor": "#F4F4F4", "backgroundTheme": "LIGHT" },
        { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 1, "backgroundColor": "#F2F2F2", "backgroundTheme": "LIGHT" }
        // ... 나머지 PREVIEW 2장 생략
      ],
      "isApptech": null,
      "isStatusOpen": false,
      "isGameCategory": false
    }
  }
}
```

**핵심**:

- **`approvalType` / `rejectedMessage`는 `miniApp` 밖, `success` 바로 아래의 flat 필드다.** 얼핏 "이제 `miniApp` 안에 들어갔겠지"로 짐작하기 쉬운데(구 `/with-draft`가 envelope-level에 두던 걸 새 envelope이 `miniApp`을 감싸는 형태로 바뀌었으니) 실측 결과는 그렇지 않다 — `miniApp` 옆의 형제 필드로 남아 있다. 이 문서의 초안도 이 가정을 틀리게 했다가 검증 단계의 2차 실측(live probe)에서 잡혔다: `MiniAppDetail.miniApp.approvalType`을 읽는 코드는 항상 `undefined`만 받아 `app status`가 실제로는 검수 통과된 앱도 조용히 `not-submitted`로 보고했을 것 — 배포 전에 잡힌 회귀다. 구현은 `src/api/mini-apps.ts#fetchMiniAppDetail`이 `success.approvalType`/`success.rejectedMessage`를 직접 읽어 `MiniAppDetail`의 top-level 필드로 노출한다.
- `hasApproved`/`hasInReview`/`hasDraft`/`isBeforeFirstReview`는 예전 `current !== null`/`draft !== null` 두 record 존재 여부 체크를 대신하는 boolean 요약이다. `hasApproved`가 옛 `current !== null`, `hasDraft`가 옛 `draft !== null` 역할 (APPROVED 케이스 1건에서만 확인 — REVIEW/REJECTED 앱 실측 시 재검증 필요).
- **`draft`/`draft ?? current` 스타일의 두 독립 payload는 이제 없다.** 단일 `miniApp` snapshot뿐이라 필드 단위 draft↔current 비교(`aitcc app show --diff`가 예전에 하던 일)는 이 endpoint만으론 재현 불가능 — `app show --diff`는 `diffAvailable: false` + 위 flag들만 보고하도록 낮췄다 (아래 "Drift history" 5번, `src/commands/app.ts` `showCommand` 참조).
- `miniApp` 자신의 필드들은 위 shape이 `success` 바로 아래에도 그대로 복제돼 있다(서버 측 중복) — `fetchMiniAppDetail`은 이 중복을 읽지 않고 `success.miniApp`만 신뢰한다.

## `GET /workspaces/<wid>/mini-app/<mini_app_id>/draft` — draft 전용 조회

- **Used by**: 아직 CLI에서 사용 안 함 (issue #219 조사 중 존재만 확인).
- **Capture status**: ⚠️ partial — populated draft가 없는 상태(31146, draft 없음)에서 구조화된 에러만 확인. draft가 실제로 존재하는 앱에서의 success shape은 미보유.
- **Error response (draft 없음, 2026-07-23 확인)**:

```json
{
  "resultType": "FAIL",
  "success": null,
  "error": { "errorType": 0, "errorCode": "mini-app-draft.NotFound", "reason": "MiniAppDraft not found. serviceId=<mini_app_id>", "data": {} }
}
```

구조화된 `mini-app-draft.NotFound` errorCode로 응답한다는 건 이 경로 자체는 살아있다는 뜻 — `/with-draft`처럼 route 자체가 없어진 404가 아니다. `hasDraft: true`인 앱으로 재현되면 populated shape을 이 섹션에 추가한다.

---

### (역사적 기록, 2026-04-22 ~ 2026-07-22) `GET /workspaces/<wid>/mini-app/<mini_app_id>/with-draft` — 앱 상세 + draft

> ⚠️ **DEPRECATED — 이 경로는 2026-07-23부터 404다** (issue #219, "Drift history" 5번). 아래는 그 이전 기간 동안 실제로 동작했던 캡처를 역사적 기록으로 남긴 것 — 새 코드가 이 경로를 다시 호출하지 않도록, 그리고 `current`/`draft`/`approvalType`이 위 새 endpoint의 `hasApproved`/`hasDraft`/`approvalType`(flat)으로 어떻게 대응되는지 참고하기 위해 보존한다. **현재 read path는 위 섹션**이다.

- **Used by (당시)**: `aitcc app status`, `aitcc app show` (review lock + draft view를 같이 surface; `--diff`로 draft↔current 비교), `aitcc app ls`.
- **Capture status**: 🗄️ historical (2026-04-22, miniAppId 29349; 2026-05-01 envelope 필드 보강) — 더 이상 재현 불가 (404).
- **Response shape (당시)**:

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "approvalType": "REVIEW",       // "APPROVED" | "REVIEW" | "REJECTED" — 서버 권위 상태. 앱 객체 내부 X, envelope-level.
    "rejectedMessage": null,        // approvalType === "REJECTED"일 때만 string. 그 외 null.
    "current": null,                // {miniApp, impression} 또는 null. 검수 통과 이력 있을 때만 채워짐.
    "draft": {                       // {miniApp, impression} 또는 null. update/검수 진행 중일 때 채워짐.
      "miniApp": {
        "miniAppId": 29349,
        "workspaceId": 3095,
        "title": "<app_title_ko>",
        "titleEn": "<app_title_en>",
        "appName": "<app_name>",
        "status": "PREPARE",         // 항상 "PREPARE" — published 여부는 firstReleaseDate로 판단.
        "iconUri": "https://static.toss.im/appsintoss/3095/<image_uuid>.png",
        "darkModeIconUri": null,
        "homePageUri": "<home_page_uri>",
        "description": "<app_subtitle>",
        "detailDescription": "<app_description>",
        "csEmail": "<email>",
        "firstReleaseDate": null,    // null = 한 번도 출시 안 함. 출시 후엔 ISO 타임스탬프.
        "isStatusOpen": false,       // 출시 토글 상태로 추정 (미검증).
        "images": [
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "THUMBNAIL", "orientation": "HORIZONTAL", "displayOrder": 0 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 1 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 2 },
          { "imageUrl": "https://static.toss.im/appsintoss/3095/<image_uuid>.png", "imageType": "PREVIEW",   "orientation": "VERTICAL",   "displayOrder": 3 }
        ]
        // 그 외 필드: minAge, maxAge, csContract, csChatUri, gameInfo, loginClientId, isContest, specialCategory, hasHarmfulContent, isGameCategory
      },
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
```

**핵심**:

- `approvalType` + `rejectedMessage`는 **envelope-level** (`success.*`). 미니앱 객체 내부엔 없다 — `bundles`/`templates`처럼 review 객체가 따로 있는 도메인과 구조가 다르다.
- `current`/`draft`는 둘 다 `{miniApp, impression}` 형태. update mode 작성 시 `draft ?? current`에서 떠다 쓰면 둘 다 커버.
- `current`는 검수 통과 이력 없으면 `null`. 출시(release) 안 했어도 검수만 통과했으면 채워짐 (단 `firstReleaseDate`는 출시 전까지 `null`).
- `draft.miniApp`이 등록 시 보낸 모든 필드를 그대로 들고 있다. `categoryPaths`는 서버가 `categoryIds`로부터 자동 매핑해 만든 객체 트리.

#### `approvalType` × `current` × `draft` 매트릭스 (관찰된 조합)

| approvalType | current | draft | 의미 |
|---|---|---|---|
| `REVIEW` | `null` | `{...}` | 첫 검수 진행 중 (create 직후 또는 REJECTED → update). |
| `REVIEW` | `{...}` | `{...}` | 통과한 적 있고 update로 다시 검수 큐 진입 (변경된 부분은 `draft`). |
| `APPROVED` | `{...}` | `null` | 검수 통과한 clean 상태 (변경 없음). |
| `APPROVED` | `{...}` | `{...}` | 미검증 — 통과 후 update 직후 ~3초 동안의 transient 상태로 추정. 정상화되면 `REVIEW` + `current` 유지로 flip. |
| `REJECTED` | `null` | `{...}` | 첫 검수에서 반려. `rejectedMessage`에 사유. |
| `REJECTED` | `{...}` | `{...}` | 미관찰. |

#### CLI 활용 (`aitcc app status` 계획)

`approvalType` + `current.firstReleaseDate` + `draft` 조합으로 사용자 친화 상태를 derive:

- `approvalType: "REVIEW"` → "검수 중"
- `approvalType: "REJECTED"` → "반려: \<rejectedMessage>"
- `approvalType: "APPROVED" && current.firstReleaseDate == null` → "검수 통과 — 출시 대기"
- `approvalType: "APPROVED" && current.firstReleaseDate != null` → "출시 중"

서버 권위 상태가 필요하면 별도로 [`/review-status`](#-get-workspaceswidmini-appmini_app_idreview-status--개별-앱-심사-상태)를 호출한다.

> (2026-07-23 갱신) 위 "계획"은 `/with-draft`가 살아있던 시절 문서다. 현재 `aitcc app status` 구현은 같은 아이디어를 [새 `GET /mini-app/<mini_app_id>` endpoint](#-get-workspaceswidmini-appmini_app_id--앱-상세-single-snapshot-2026-07-23)의 `approvalType`/`hasApproved`/`hasDraft`로 derive한다 — `src/commands/app.ts`의 `deriveReviewState`/`reviewStateInputFrom` 참조.

---

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

## `DELETE /workspaces/<wid>/mini-app/<mini_app_id>` — 앱 삭제 (route 존재, 일반 OWNER 세션에는 막힘)

- **Used by**: 없음 (CLI 미구현).
- **Capture status**: 🚫 user-inaccessible. 2026-04-23 수동 probe로 동작 확인 (상세 아래).

### Probe 결과

`OPTIONS` preflight 응답에 `access-control-allow-methods: DELETE`가 포함돼 route 자체는 실재함이 확인된다. 그러나 workspace OWNER 세션으로 실제 `DELETE`를 보내면 어떤 변형(plain / `{}` body / `?confirm=true` query)이든 일관되게 다음을 반환한다:

```jsonc
// HTTP 200 (envelope이 FAIL이라 status는 200)
{
  "resultType": "FAIL",
  "success": null,
  "error": {
    "errorType": 0,
    "errorCode": "500",
    "reason": "Internal Server Error",
    "data": {},
    "title": null
  }
}
// response header: x-toss-event-id: <trace_id>
// upstream-service-time: ~18ms (timeout 아니라 즉시 실패)
```

**테스트한 대상 상태별 결과** (2026-04-23, miniAppId 29349/29356/29397):
- PREPARE 상태 draft (검토 미시작): 500
- 검토 중인 앱: 500

**해석**: 응답 시간이 빠르고(~18 ms) `errorCode: 500`을 깔끔하게 반환하므로 **timeout이 아니라 서버 로직이 실행돼 의도적으로 거부**한 것. 비교 대상으로 같은 워크스페이스의 sibling DELETE — `DELETE /workspaces/<wid>/members/<bizUserNo>` 와 `DELETE /workspaces/<wid>/invites` — 는 동일 세션으로 정상 동작한다. 즉 이 endpoint만 OWNER 권한 위(아마 토스 운영팀 admin role)에서만 동작하는 것으로 보인다.

**결론**: 사용자(앱 등록 주체)가 자기 앱을 직접 삭제할 방법은 콘솔 SPA에 없다. dog-food 결과로 생긴 잔여 앱을 정리하려면 콘솔의 1:1 문의/채널톡으로 운영팀에 요청한다 (대상 `miniAppId` + 위 trace id 첨부 권장).

CLI에 `aitcc app delete`를 추가하더라도 stub으로만(`exit 16`, `reason: "delete-not-supported"`) 두는 게 정직 — 실 endpoint가 열리기 전엔 사용자가 콘솔 운영팀에 직접 요청하라는 안내를 출력해야 한다.

## sdk-example dog-food 앱 상태 (2026-05-22 갱신)

본 인벤토리 캡처에 사용한 5개 앱 중 **추적 대상은 `31146` 한 개뿐**이다. 나머지 4개는 운영팀 처리 trail로 남기고 우리 쪽 SLA tracking에서 제외 — 운영팀 처리 결과와 무관하게 다시 건드리지 않는다. 모두 워크스페이스 `3095`(sdk-example dog-food). 추가 dog-food 시 새 앱 만들지 말고 `31146`에 update mode로 적용 (`miniApp.miniAppId: 31146` 포함).

### 추적 대상

| miniAppId | appName | reviewState | locked | serviceStatus | deployed bundle | 용도 |
|---|---|---|---|---|---|---|
| `31146` | `aitc-sdk-example` | `approved` | `false` | `PREPARE` | `null` | **메인 (최종)**. AITC.DEV 브랜드. 앱 등록 검수 통과 — 2026-05-03 진입한 REVIEW lock이 풀렸다(2026-05-22 실측). 추가 변경은 update mode로만. |

**검수가 두 층이라는 점이 중요하다** — `31146`은 *앱 등록(메타데이터) 검수*는 통과(`reviewState: approved`)했지만 `serviceStatus`는 여전히 `PREPARE`다. 이유는 review 실패가 아니라, 업로드된 번들 전부가 `reviewStatus: CREATED`(번들 출시 검수 미제출)이기 때문이다. 출시 흐름은 `bundles upload → bundles review(제출) → 운영팀 APPROVED → bundles release --confirm → serviceStatus OPENED`인데, dog-food는 `upload`만 반복했고 `review` 제출을 한 적이 없다. 그래서 release된 번들이 없어(`bundles deployed: null`) PREPARE에 정상적으로 머문다. OPENED로 넘기려면 한 deployment를 `bundles review`로 제출 → APPROVED 후 `bundles release --confirm` 해야 한다.

### 운영팀 처리 trail (touch 금지, tracking 불필요)

| miniAppId | appName | 메모 |
|---|---|---|
| `29349` | `ait-sdk-example` | 메인 (구). probe-temp 키워드 draft. |
| `29356` | `ait-sdk-example-probe-b` | `폐기: SDK 레퍼런스 (b)` 라벨로 검수 큐 진입. |
| `29397` | `ait-sdk-example-probe-c` | REVIEW 잠금이라 라벨 미반영. |
| `29405` | `ait-sdk-example-final` | `폐기: SDK 레퍼런스 (final)` 라벨로 검수 큐 진입. |

4개 모두 한 번 REJECTED → 다음 state 전환까지 도달했다 (`with-draft.rejectedMessage`는 `approvalType === REJECTED`일 때만 채워지므로 현재는 모두 `null`). 2026-05-02 채널톡으로 정리 요청 발송 — 운영팀 처리 대기 중이며, 우리 쪽 후속 액션 없음.

**중요 메모**:
- 현재 출시(`serviceStatus: OPENED`)된 앱은 **0개**. 31146은 앱 등록 검수를 통과했지만(`reviewState: approved`) 번들 출시 검수를 한 번도 제출하지 않아 `PREPARE`다 (위 "추적 대상" 표 아래 설명 참조).
- 31146의 lock 해제 여부는 `app status`(당시 `/with-draft`의 `reviewState`)와 `app service-status`(`/review-status`)가 일치한다 — 2026-05-22 실측 둘 다 `approved`/`locked:false`. 과거 메모는 `approvalType === REVIEW`를 권위로 봤는데, 현재 CLI는 그 신호를 `reviewState`/`locked`로 정규화해 노출한다. 둘이 어긋나면 server-authoritative한 `service-status`를 믿는다.
- **새 앱 등록 금지**. 31146 등록으로 dog-food 사이클 종료 — update mode에서 REVIEW lock(4046) 걸려도 새 앱 만들지 말고 운영팀 처리 대기.
- **재검증 (issue #219, 2026-07-23)**: `/with-draft` 404 전환 이후 새 read path(`GET /mini-app/<mini_app_id>`)로 31146을 다시 실측 — `aitcc app status`/`aitcc app show` 모두 이전과 동일하게 `state: approved` / `locked: false` / `serviceStatus: PREPARE`를 보고한다. 회귀 없음.
