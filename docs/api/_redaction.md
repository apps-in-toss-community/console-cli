# Redaction 정책

캡처된 raw 본문을 이 인벤토리에 인라인 JSON으로 박을 때 적용하는 치환 규칙이다. 새 캡처를 추가할 때 이 표를 점검표로 쓴다.

## 절대 캡처하지 않는 것

다음 헤더/필드는 처음부터 캡처/저장에 포함시키지 않는다:

- `Cookie` 요청 헤더, `Set-Cookie` 응답 헤더
- `Authorization` 헤더 (현재 콘솔에는 없지만 추가될 수 있음)
- 세션 ID, CSRF token, 트래킹 ID(`x-toss-trace-id`, `sentry-trace`, `baggage`)

## 치환 규칙

| 원본 | placeholder | 비고 |
|---|---|---|
| 사용자 이름 | `<name>` | 예: `"최병훈"` → `"<name>"` |
| 사용자 이메일 | `<email>` | 예: `"helloworld4625@gmail.com"` → `"<email>"` |
| `csEmail` (manifest 필드, 사용자가 입력하는 고객문의 이메일) | `<email>` | 사용자 본인 이메일과 같을 수 있음 |
| `userId`, `id` (member 객체의 user id) | `<user_id>` | 정수. 예: `6825` |
| `bizUserNo` | `<biz_user_no>` | 정수 |
| `channelIoHash` | `<channel_io_hash>` | 채널톡 식별 hash |
| 워크스페이스/회사명 | `<workspace_name>` | 예: `"(주)프로덕트팩토리"` → `"<workspace_name>"`. **본 커뮤니티 워크스페이스(`3095` "(주)프로덕트팩토리" — sdk-example dog-food 호스트)만 이름 그대로 둔다.** |
| 워크스페이스 ID | `<workspace_id>` | sdk-example dog-food (`3095`)만 그대로 노출. maintainer 개인/테스트 워크스페이스 ID(예: `36577`)는 모두 `<workspace_id>`. |
| `appName` (kebab-case slug) | `<app_name>` | 예: `"ait-sdk-example"` → `"<app_name>"` |
| 미니앱 한국어/영어 제목 | `<app_title_ko>` / `<app_title_en>` | 사용자 입력값 |
| `homePageUri` | `<home_page_uri>` | 예: `https://example.org/...` |
| `description`, `detailDescription` | `<app_subtitle>`, `<app_description>` | 사용자 입력 본문. shape 보존을 위해 길이는 짧게 |
| `keywordList` 항목들 | `["<keyword>", ...]` | 갯수만 보존, 내용은 placeholder |
| 이미지 CDN URL의 UUID | `<image_uuid>` | `https://static.toss.im/appsintoss/<wid>/<image_uuid>.png` 형태로 host/path는 유지 |
| `miniAppId`(특정 사용자의 앱 id) | 그대로 두되 본 inventory 작성에 사용된 sdk-example dog-food 앱들(29349, 29356, 29397, 29405)은 공개 식별자로 취급 |

## 유지하는 것 (redact 안 함)

다음은 redact하지 않는다 — 인벤토리의 실제 가치 때문에:

- HTTP method, URL path, query parameter 키 (값은 케이스별)
- 응답 envelope 구조 (`resultType`, `success`, `error.errorCode`, `error.reason`)
- enum 값 (`status: "PREPARE"`, `imageType: "THUMBNAIL"`, `orientation: "HORIZONTAL"` 등)
- 상수성 ID (workspace `3095`, sdk-example dog-food 앱 ID들, 카테고리 ID들 — 이미 [`impression.md`](./impression.md)에 전수 등록됨)
- 시간 형식 (`capturedAt`, `firstReleaseDate`)
- boolean / 수치 필드 (`isAdult`, `minAge`, `displayOrder`)

## 검토 체크리스트

새 캡처를 commit하기 전에:

1. `grep -E "@[a-z0-9.-]+\\.[a-z]{2,}"` — 이메일 누락 점검.
2. `grep -E "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"` — UUID 누락 점검.
3. `grep -iE "cookie|authorization|sessionid|bearer\\s"` — 인증 정보 누락 점검.
4. 한국어 회사명 / 사람이름 휴리스틱: `grep -E "주식회사|\\(주\\)|[가-힣]{2,4}\\b"` 후 사람-같은 단어 manual 확인.
