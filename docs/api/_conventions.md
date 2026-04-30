# 공통 규약

## Base URL

대부분의 endpoint는 다음 base 아래에 있다:

```
https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole
```

예외:

| Endpoint group | Host |
|---|---|
| Notices | `https://api-public.toss.im/api-public/v3/ipd-thor/api/v1` |
| Resource (이미지) 업로드 | 같은 base, 단 path가 `/resource/...` (워크스페이스 prefix 없음) |

이하 모든 path는 별도 명시 없으면 base **상대** 경로다.

## Auth

- HttpOnly **세션 쿠키** 한 가지 (`apps-in-toss.toss.im` 도메인). bearer token / API key 없음.
- 모든 요청에 `credentials: 'include'` (브라우저) 또는 직렬화된 `Cookie:` 헤더 (CLI) 필요.
- 세션 무효화 시 HTTP 401 또는 envelope `errorCode: '4010'` 반환.

## 공통 응답 envelope

성공/실패 모두 같은 wrapper:

```jsonc
// Success
{ "resultType": "SUCCESS", "success": <data> }

// Failure
{ "resultType": "FAIL", "error": { "reason": "<message>", "errorCode": "<code>", ... } }
```

CLI 측에서는 [`src/api/http.ts`](../../src/api/http.ts)의 `unwrap()`이 이 wrapper를 벗기고, 실패는 `TossApiError`로 변환한다 (401 / `errorCode: '4010'`이면 `isAuthError: true`).

**알려진 errorCode**:

| code | 의미 |
|---|---|
| `4000` | "잘못된 요청입니다" — 서버측 validation 실패 (charset, length, 누락 필드 등). `error.reason`에 한국어 설명. |
| `4010` | 인증 만료/없음. `aitcc login` 재실행 유도. |

## Path / query / body 컨벤션

- Workspace context는 항상 **path parameter** (`/workspaces/<workspace_id>/...`)로 들어간다. 헤더 아님.
- Mini-app id는 **singular** path: `/mini-app/<mini_app_id>/...`. 단 `app reports`만 plural (`/mini-apps/<mini_app_id>/user-reports`).
- 응답 페이지네이션:
  - 대부분 page-based: `{contents, totalPage, currentPage}` 또는 `{items, paging}`.
  - `app reports`만 cursor-based: `{reports, nextCursor, hasMore}`.
- Body는 모두 JSON. 예외는 `/resource/<workspace_id>/upload` (`multipart/form-data`).

## Read view 차이 (`/with-draft` vs current)

미니앱 조회는 두 가지 view가 있다:

- `GET /workspaces/<wid>/mini-app/<mini_app_id>` — **current view**. 검수 통과한 마지막 published 상태. 신규 등록 직후엔 대부분 필드 `null`이다.
- `GET /workspaces/<wid>/mini-app/<mini_app_id>/with-draft` — **`{ current, draft }`**. 등록 시 보낸 모든 필드는 여기 `draft.miniApp` 안에 그대로 살아있다.

CLI에서 등록 직후 "필드가 사라졌다"고 오해한 적이 있는데(0.1.7 회귀), 그건 current를 draft로 착각한 결과였다. **편집/조회는 항상 `/with-draft`를 우선해야 한다.** 자세한 경위는 [`mini-apps.md`](./mini-apps.md)의 "Drift history" 섹션.

## 캡처/redaction 정책

- 인증 헤더(`cookie`, `authorization`), 세션 ID, 토큰류는 처음부터 캡처하지 않는다.
- 사용자 식별 데이터(이메일, 이름, bizUserNo, userId, channelIoHash)는 placeholder로 치환. 상세는 [`_redaction.md`](./_redaction.md).
- 워크스페이스 ID는 **sdk-example dog-food (`3095`)만 그대로 노출**한다 — 이건 본 커뮤니티 자체 워크스페이스라 공개 OK. 그 외 maintainer 개인/테스트 워크스페이스 ID는 `<workspace_id>`로 치환.
- 워크스페이스/회사명은 `<workspace_name>`으로 치환.
- 이미지 CDN URL의 UUID 부분은 placeholder (`<image_uuid>`)로 치환, host/path 패턴은 유지 — CDN URL 구조 자체는 인벤토리 가치가 있음.
