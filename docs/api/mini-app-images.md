# Mini-apps · 이미지 업로드

미니앱 등록(`POST /workspaces/<wid>/mini-app/review`)에서 참조하는 이미지(`iconUri`, `darkModeIconUri`, `images[].imageUrl`)는 모두 사전에 이 endpoint로 업로드해 받아낸 CDN URL이다.

## `POST /resource/<wid>/upload` — 파일 업로드 (multipart)

> **Path 주의**: 다른 endpoint와 달리 base가 `<host>/console/api-public/v3/appsintossconsole/resource/...`이지만 **워크스페이스 path 부분이 `/workspaces/<wid>` 아닌 `/resource/<wid>`**이다.

- **Used by**: [`src/api/mini-apps.ts#uploadMiniAppResource`](../../src/api/mini-apps.ts), [`src/commands/register.ts`](../../src/commands/register.ts)
- **Capture status**: ✅ confirmed (2026-04-22 dog-food)
- **Auth**: 세션 쿠키
- **Content-Type**: `multipart/form-data`

### Query parameters

| 키 | 값 | 비고 |
|---|---|---|
| `validWidth` | 정수 (px) | 이미지 width hard validation. 일치 안 하면 4000 |
| `validHeight` | 정수 (px) | 이미지 height hard validation |
| `fileType` | enum 문자열 (선택) | 예: `DATING_APP_CHECKLIST_PDF`. 미니앱 이미지는 미지정 |
| `public` | `true`/`false` (선택) | 비공개 리소스. 미니앱 이미지는 미지정 (= public) |

미니앱 이미지의 dimension 요구사항 (CLI [`src/config/image-validator.ts`](../../src/config/image-validator.ts)도 동일):

| 슬롯 | dimension | type/orientation |
|---|---|---|
| 로고 (`iconUri`) | 600 × 600 | (이미지 자체) |
| 다크모드 로고 (`darkModeIconUri`, optional) | 600 × 600 | (이미지 자체) |
| 가로 썸네일 (`horizontalThumbnail`) | 1932 × 828 | `THUMBNAIL` / `HORIZONTAL` |
| 세로 스크린샷 (≥3장) | 636 × 1048 | `PREVIEW` / `VERTICAL` |
| 가로 스크린샷 (optional) | 1504 × 741 | `PREVIEW` / `HORIZONTAL` |

### Request body (multipart/form-data)

| field | 값 |
|---|---|
| `resource` | 파일 바이너리 |
| `fileName` | 원본 파일명 (예: `logo.png`) |

### Response

```json
{
  "resultType": "SUCCESS",
  "success": "https://static.toss.im/appsintoss/3095/<image_uuid>.png"
}
```

**`success`가 string 그대로** (객체가 아니라). CDN URL을 그대로 mini-app submit body의 `iconUri` / `images[].imageUrl`에 사용.

### Error (예: 잘못된 dimension)

```json
{
  "resultType": "FAIL",
  "error": {
    "reason": "<message>",
    "errorCode": "4000"
  }
}
```

dimension 불일치, 파일 크기 초과, 지원하지 않는 형식 등이 4000으로 묶임. 정확한 reason 분류는 미캡처.

## `GET /resource/resource-center/search` — 리소스 센터 검색

- **Capture status**: ❌ not captured
- 콘솔 UI에서 업로드 이력을 검색하는 용도로 추정. CLI 미사용.

## 관련 처리 endpoint

콘솔에는 이미지 자동 처리 endpoint도 존재하지만 CLI는 사용하지 않는다 (사용자가 사전에 dimension 맞춘 이미지를 매니페스트에 명시하므로):

| Method | Path | 용도 |
|---|---|---|
| POST | `/workspaces/<wid>/image-process/thumbnail-generate` | 썸네일 자동 생성 |
| POST | `/workspaces/<wid>/image-process/screenshot-wash` | 스크린샷 정리 |
| GET | `/workspaces/<wid>/image-process/<job_id>` | job 상태 폴링 |
