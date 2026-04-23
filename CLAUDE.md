# CLAUDE.md

## 프로젝트 성격 (중요)

**`apps-in-toss-community`는 비공식(unofficial) 오픈소스 커뮤니티다.** 토스 팀과 제휴 없음. 사용자에게 보이는 산출물에서 "공식/official/토스가 제공하는/powered by Toss" 등 제휴·후원·인증 암시 표현을 **쓰지 않는다**. 대신 "커뮤니티/오픈소스/비공식"을 사용한다. 의심스러우면 빼라.

**특히 주의**: 이 CLI는 헤드리스 브라우저로 콘솔을 자동화한다. **공식 API를 호출하는 것이 아니다** — 공개 개발자 콘솔 UI를 사용자의 인증된 브라우저 세션으로 driving할 뿐이므로, 콘솔 UI가 바뀌면 셀렉터가 깨질 수 있음을 README에 명시한다.

## 짝 repo

- **`sdk-example`** (downstream consumer) — console-cli가 완성되면 sdk-example을 **앱인토스 실제 미니앱으로 배포**(현재 GitHub Pages 배포에 더해)해서 E2E 검증. 이게 CLI의 주요 품질 게이트.
- **`agent-plugin`** — `/ait deploy`, `/ait logs` 같은 skill이 **Bash로 이 CLI를 shell out** 호출한다. MCP wrapping하지 않는다(umbrella MCP 전략의 "CLI를 MCP로 wrapping하지 않는다" 원칙). `--json` 플래그로 출력을 파싱하면 충분하다.

독립 실행 가능. 다른 repo 변경 없이 배포 가능.

## 프로젝트 개요

**console-cli** — 앱인토스 개발자 콘솔(웹 UI)을 CLI로 자동화.

### 동작 방식

1. 최초 실행 시 사용자의 시스템 Chrome(또는 Chromium-family)을 CDP로 spawn해 사용자가 직접 로그인.
2. 로그인 완료 감지 즉시 `Network.getAllCookies`로 HttpOnly 포함 세션 쿠키 전체를 로컬 XDG 경로(`$XDG_CONFIG_HOME/aitcc/session.json`, fallback `~/.config/aitcc/session.json`)에 `0600`으로 저장.
3. 이후 명령은 저장된 쿠키를 `Cookie:` 헤더로 직렬화해 `fetch()`로 콘솔 API 직접 호출. Playwright 등 브라우저 재기동 없음.
4. `aitcc login | logout | whoami | upgrade`가 현재 MVP. `deploy | logs | status`는 TODO.md 참고.
5. `agent-plugin`이 이 CLI를 Bash로 호출 (MCP wrapping 없음).

### 보안 고려

- 세션 쿠키는 **절대 로그/stdout에 출력 금지**. `--verbose`도 민감 정보 redact.
- `whoami` 라이브 호출이 노출하는 건 `user.name` / `email` / `role` / `workspaces`뿐.
- Chrome은 ephemeral `--user-data-dir`에서 spawn되어 사용자의 일상 브라우저 프로필과 완전히 격리. 세션 캡처 후 temp 디렉토리 삭제.

## 아키텍처

### Command surface (`citty`)

CLI는 [`citty`](https://github.com/unjs/citty) 기반. 이유: subcommand 트리, `--help`/`--version` 자동 생성, UnJS 생태계와의 궁합. 큰 의존성(oclif 등) 대비 bundle size가 작아 `bun build --compile`에 유리.

MVP (0.1.x scaffold에서 다룬 범위):

| Command | Status | Purpose |
| --- | --- | --- |
| `aitcc --version` | ✅ | build time에 `package.json`의 `version`을 `AITCC_VERSION` define으로 주입. |
| `aitcc --help` | ✅ | `citty` 자동 생성. |
| `aitcc whoami` | ✅ | 세션 쿠키로 콘솔 `members/me/user-info`를 호출해 라이브 데이터 반환. `--offline`로 캐시된 정체만 읽기. 세션 없으면 exit 10. |
| `aitcc login` | ✅ | CDP로 시스템 Chrome을 격리된 `--user-data-dir`에 띄우고 Toss 비즈니스 sign-in URL로 이동. 메인 프레임이 `apps-in-toss.toss.im/workspace*`에 도달하면 `Network.getAllCookies`로 HttpOnly 포함 모든 쿠키 덤프, 세션 저장. |
| `aitcc logout` | ✅ | `session.json` 삭제. 파일이 없어도 no-op (exit 0). |
| `aitcc upgrade` | ✅ | GitHub Releases latest 조회 → 임베드 버전과 비교 → 플랫폼/아키 바이너리 다운로드 → atomic 교체. |
| `aitcc app ls` | ✅ | 현재 워크스페이스의 미니앱 목록. `--json`으로 agent-plugin 소비. |
| `aitcc app register` | ✅ | YAML/JSON 매니페스트 + 이미지 업로드 + 등록+심사 요청 one-shot. submit payload shape는 dog-food task #23 (2026-04-22) 에서 실제 네트워크로 확정됨. 완전한 body로 제출 시 앱이 즉시 "검토 중" 상태로 진입. |
| `aitcc app show <id>` | ✅ | `GET /mini-app/:id/with-draft` 로 draft + current 전체 뷰. `--view draft|current|merged` 로 어느 쪽 볼지 선택. 기본값은 `draft` — 미검수 앱에서 current는 비어있음. |
| `aitcc app status <id>` | ✅ | 앱의 리뷰 상태 (under-review / rejected / approved / approved-with-edits / not-submitted / unknown). `--watch --interval <sec>` 로 상태가 바뀔 때까지 polling. `/with-draft` envelope 필드 (`approvalType`, `current`, `rejectedMessage`, `draft`) 조합으로 derive. |
| `aitcc app ratings <id>` | ✅ | 사용자 평점·리뷰 목록. `GET /mini-app/:id/app-ratings?page&size&sortField&sortDirection`. `--page`/`--size`/`--sort-field CREATED_AT\|SCORE`/`--sort-direction ASC\|DESC` 지원. 응답에 `averageRating`, `totalReviewCount`, `paging.hasNext` 포함. |
| `aitcc app reports <id>` | ✅ | 사용자 신고 내역. `GET /mini-apps/:id/user-reports?pageSize&cursor` (**plural** `mini-apps`). Cursor-based pagination — `--cursor`로 다음 페이지 opaque token 전달. 응답: `{reports, nextCursor, hasMore}`. |
| `aitcc app bundles ls <id>` | ✅ | 앱 업로드 번들 목록. `GET /mini-app/:id/bundles[?page&tested&deployStatus]` — page-based pagination, `{contents, totalPage, currentPage}`. `--page`/`--tested true\|false`/`--deploy-status STR` 필터. |
| `aitcc app bundles deployed <id>` | ✅ | 현재 배포된 번들 (single record or null). `GET /mini-app/:id/bundles/deployed`. Deploy 확인용 — "지금 살아있는 버전이 뭐지?" 질문에 바로 답. |
| `aitcc app certs ls <id>` | ✅ | 앱 mTLS 인증서 목록. `GET /mini-app/:id/certs` — simple array. Follow-up `certs create`/`revoke`는 UI flow 관찰 후. |
| `aitcc app metrics <id>` | ✅ | 앱 전환 지표. `GET /mini-app/:id/conversion-metrics?refresh=&timeUnitType=DAY\|WEEK\|MONTH&startDate=&endDate=`. 기본 창은 오늘 기준 최근 30일, `--time-unit`/`--start`/`--end`/`--refresh` 제공. PREPARE 상태 앱은 `metrics: []` + `cacheTime` (서버 캐시 ISO 타임스탬프)만 반환. Per-record shape는 live 트래픽 관찰 후 pin. |
| `aitcc app share-rewards ls <id>` | ✅ | 앱 공유 리워드 프로모션 목록. `GET /mini-app/:id/share-rewards?search=`. 서버가 `search=` 쿼리를 기대해 비어 있어도 항상 포함. `--search <text>`로 title-contains 필터. Simple array. |
| `aitcc app messages ls <id>` | ✅ | 스마트 발송(구 푸시알림) 캠페인 목록. `POST /mini-app/:id/smart-message/campaigns?page&size` with body `{sort:[{field,direction}], search, filters}`. 응답: `{items, paging: {pageNumber, pageSize, hasNext, totalCount}}`. `--page`/`--size`/`--search` 지원. Filters/sort는 현재 UI 기본값만 전송; 캠페인 record shape는 live 관찰로 pin. |
| `aitcc notices ls / show <id> / categories` | ✅ | 앱인토스 공지사항. 별도 서비스 (`api-public.toss.im/api-public/v3/ipd-thor`, hard-coded `workspaceId=129` — 모든 유저 공유). `ls`는 page-based + `--search` title-contains 필터, `show`는 single post, `categories`는 7개 버킷 post count. 세션 쿠키(`.toss.im` 도메인)로 자동 인증. |
| `aitcc workspace partner` | ✅ | 워크스페이스의 파트너(정산/페이아웃) 등록 상태. `GET /workspaces/:id/partner` — `{registered, approvalType, rejectMessage, partner}`. 초기 상태는 `registered: false, approvalType: 'DRAFT'`. `--workspace <id>`로 다른 워크스페이스 조회 가능. Partner record shape는 approval 승인 후 live 관찰로 pin. |
| `aitcc workspace terms` | ✅ | 워크스페이스가 기능별로 동의해야 하는 약관 목록과 동의 상태. `GET /workspaces/:id/console-workspace-terms/:type/skip-permission`. 5개 타입: `TOSS_LOGIN`, `BIZ_WORKSPACE`, `TOSS_PROMOTION_MONEY`, `IAA`, `IAP`. `--type <TYPE>`로 단일 버킷, 기본은 5개 전부 병렬 조회 후 묶어 출력. `--json`에선 단일 타입은 `terms[]`, 전체 조회는 `byType: {TYPE: terms[]}`. 각 term은 `{required, termsId, revisionId, title, contentsUrl, actionType, isAgreed, isOneTimeConsent}`. |

Next (tracked in TODO.md, 이 scaffold 단계에는 없음): `deploy [path]`, `logs [--tail]`, `status`, (deferred) `mcp`.

**Non-goals for 0.1.x**: 플러그인 시스템, multi-account switching, release-notes 생성. 모두 Dave의 명시적 `minor`/`major` 승인 뒤에.

### Exit codes

`src/exit.ts`에 중앙화. 각 command는 의미 있는 exit code를 약속하고 `--json` 계약과 함께 문서화한다. agent-plugin skill이 이 값으로 분기하므로 **기존 코드의 의미를 바꾸는 건 breaking change**.

### `--json` 계약

- 모든 command가 `--json` 지원.
- `--json` 설정 시: stdout은 **한 줄짜리 JSON document**, stderr는 plain text 진단 메시지.
- 기본 출력: stdout이 TTY면 색, 아니면 plain. `NO_COLOR` 존중.
- `agent-plugin` skill은 항상 `--json`으로 shell out하고 stdout을 파싱한다.

### Session storage

- **위치**: XDG Base Directory. `$XDG_CONFIG_HOME/aitcc/session.json` → fallback `~/.config/aitcc/session.json` (Linux/macOS), `%APPDATA%\aitcc\session.json` (Windows).
- **권한**: 디렉토리 `0700`, 파일 `0600`. `fs.mkdir({ mode: 0o700 })` + `fs.writeFile({ mode: 0o600 })`. Windows에선 mode 호출이 best-effort no-op, 유저 프로필 ACL에 의존.
- **Shape**: `schemaVersion: 2`, `user`, `cookies`, `origins`, `capturedAt`, `currentWorkspaceId?`. `cookies`/`origins`은 Playwright `storageState` 그대로. v1 파일은 `readSession`이 자동으로 v2로 마이그레이트.

### Session storage 선택 근거 (plain `0600` vs keychain)

**현재: plain `0600` 파일.** 근거:

- OS keychain (`keytar`, Windows Credential Manager, Secret Service)은 **네이티브 의존성**이라 `bun build --compile`이 플랫폼별로 깔끔하게 번들하지 못한다. 현재 Bun 기준 cross-platform 지원이 불완전.
- XDG 디렉토리 안 `0600` 파일은 첫 릴리즈의 **pragmatic floor**. `gh`/`gcloud`/`firebase` CLI 모두 과거에 거쳐 온 형태.
- **나중에 keychain으로 마이그레이션이 쉬움**: `cookies`/`origins`만 keychain으로 옮기고 나머지는 `session.json`에 남긴다. 기존 데이터 migration 없음. Backlog 아이템.

### Login 선택 근거 (CDP capture vs OAuth callback server)

**결정: CDP로 시스템 Chrome을 spawn해 사용자 로그인 완료 감지 후 쿠키 덤프.** 초기 스캐폴드는 localhost OAuth callback server였는데 다음 이유로 폐기됨:

- 공개된 `client_id=4uktpjgqd0cp9txybqzuxc2y6w0cuupb`에 등록된 redirect_uri는 production `apps-in-toss.toss.im/sign-up` 고정. `http://127.0.0.1:<port>/callback`은 허용되지 않음.
- 인증 쿠키는 **HttpOnly**라 브라우저 JS로 capture 불가능. 반드시 CDP 레벨에서 `Network.getAllCookies`를 호출해야 함.
- Playwright 번들(~300 MB)을 끌어오면 `bun build --compile` 사이즈가 무너짐. 대신 시스템에 이미 설치된 Chrome/Edge/Chromium을 spawn해 CDP로 드라이빙함으로써 **바이너리에 브라우저가 포함되지 않는다**.

흐름:
1. `src/chrome.ts`가 OS별 Chrome 경로(override: `AITCC_BROWSER`)를 찾아 ephemeral `--user-data-dir`로 spawn. `--remote-debugging-port=0`으로 OS가 고른 포트를 stderr의 `DevTools listening on ws://…` 배너에서 파싱.
2. `src/cdp.ts`의 minimal CDP client(순수 WHATWG WebSocket, 외부 의존 없음)가 `Target.attachToTarget` → `Page.frameNavigated`를 구독.
3. 메인 프레임 URL이 `apps-in-toss.toss.im/workspace[/*]`에 도달하면 login 완료로 간주.
4. `Network.getAllCookies`로 브라우저 세션의 쿠키(HttpOnly 포함) 전체 덤프.
5. `src/api/me.ts`의 `fetchConsoleMemberUserInfo`가 쿠키로 `/console/api-public/v3/appsintossconsole/members/me/user-info` 호출해 실 사용자 정보를 확보 — 쿠키 liveness check 겸 whoami 기본값 채움.
6. Chrome kill + user-data-dir 삭제.

agent-plugin 호환성은 동일: 인터랙티브 login은 skill 안에서 절대 호출하지 않고, `whoami --json`이 `authenticated: false`면 사용자에게 `aitcc login`을 직접 돌리라고 안내한다.

### 구현 세부

- **Chrome 탐지**: `chromeCandidates()`가 `$AITCC_BROWSER` → OS별 기본 경로(macOS는 `/Applications/*.app/Contents/MacOS/...`, Windows는 `PROGRAMFILES*/Google/Chrome/Application/chrome.exe`, Linux는 PATH 상의 `google-chrome`/`chromium`/`microsoft-edge`) 순으로 시도. 전부 실패 시 `ChromeNotFoundError` → exit 14.
- **WebSocket 의존성 없음**: Node 22+ / Bun 둘 다 `globalThis.WebSocket`을 제공하므로 `ws` 패키지는 쓰지 않는다. `bun build --compile`에 native peer 문제 없이 들어간다.
- **Toss 공용 envelope**: `src/api/http.ts`가 `{ resultType: 'SUCCESS'|'FAIL', success, error? }` 래퍼를 unwrap하고, 실패는 `TossApiError`(401 or `errorCode: '4010'`이면 `isAuthError === true`)로 변환.
- **Timeout**: `--timeout <sec>`(기본 300). 내부 타이머는 `unref()` 처리.
- **세션 shape**: `{ schemaVersion: 2, user: { id, email, displayName }, cookies: CdpCookie[], origins: [], capturedAt, currentWorkspaceId? }`. `cookies`는 CDP `Network.getAllCookies` 응답 그대로 저장해 http 레이어가 `Cookie:` 헤더로 그대로 직렬화. v1 파일은 `readSession`이 자동으로 v2로 업그레이드.
- **Logout**: 세션 파일을 `unlink`. `ENOENT`면 "no active session"으로 exit 0 — idempotent.

### App registration (`aitcc app register`)

`aitcc app register` 는 콘솔의 미니앱 등록 플로우(두 스텝짜리 마법사 + 5개 필수 동의 체크박스)를 **단일 매니페스트 파일**로 자동화한다.

**Submit shape는 dog-food #23 (2026-04-22)에서 확정됨.** 초기 구현의 `{miniApp, impression}` nested wrapper + `impression.categoryIds: [number]` shape이 **정답**이었다. 한 번 "flat + categoryList: [{id}]"로 regression한 적이 있었는데 (0.1.7), 이건 `GET /mini-app/:id`가 **current view만** 반환하는 것을 draft가 소실된 것으로 오해한 결과였다 — `GET /mini-app/:id/with-draft`를 읽으면 모든 필드가 정상적으로 persist돼 있다. 자세한 경위는 `apps-in-toss-community/.playwright-mcp/FORM-SCHEMA-CAPTURED.md` "FINAL" 섹션과 `xhr-captures/` 디렉토리 참고.

**`/mini-app/review`는 이름 그대로 "앱 등록 + 심사 제출 원샷"**. 완전한 body를 보내면 앱이 즉시 "검토 중" 상태로 진입 — 별도 update 엔드포인트나 review-trigger 엔드포인트는 없다.

**매니페스트 경로**:

1. `--config <path>` 가 주어지면 그 경로 (상대 경로는 cwd 기준 resolve).
2. 아니면 `./aitcc.app.yaml` → `./aitcc.app.json` 순으로 auto-detect.
3. 매니페스트 내부의 이미지 경로 (logo, horizontalThumbnail, verticalScreenshots 등) 는 **매니페스트 파일의 디렉토리 기준**으로 resolve.

**매니페스트 스키마** (`src/config/app-manifest.ts`):

```yaml
# Required
titleKo: SDK 레퍼런스           # 한국어 앱 이름
titleEn: SDK Reference          # 영어 앱 이름
appName: ait-sdk-example        # kebab-case slug
csEmail: support@example.com    # 고객문의 이메일
logo: ./assets/logo.png         # 600×600 PNG
horizontalThumbnail: ./assets/thumb.png   # 1932×828 PNG
categoryIds: [1, 2]             # >=1. /impression/category-list 참고
subtitle: 앱인토스 SDK 인터랙티브 예제   # <= 20 chars
description: |-
  상세 설명 (멀티라인 YAML OK)
verticalScreenshots:            # >= 3 장, 각각 636×1048 PNG
  - ./assets/s1.png
  - ./assets/s2.png
  - ./assets/s3.png

# Optional
homePageUri: https://example.com/
logoDarkMode: ./assets/logo-dark.png     # 600×600 PNG
keywords: [sdk, example]                  # <= 10 entries
horizontalScreenshots:                    # 각 1504×741 PNG
  - ./assets/h1.png
```

**이미지 dimension 은 업로드 전에 로컬 검증**. 서버도 `?validWidth=W&validHeight=H` 쿼리로 하드 검증하지만, agent-plugin 이 structured error 를 받을 수 있도록 먼저 로컬에서 체크한다 (`src/config/image-validator.ts`).

**실행 흐름**:

1. 세션 로드 + workspace 확정 (`resolveWorkspaceContext`).
2. 매니페스트 parse + 필드 validation.
3. 이미지 dimension 검증 (로컬).
4. 각 이미지 순차 업로드 (`POST /resource/:wid/upload?validWidth=W&validHeight=H` multipart). 응답은 `{ resultType: 'SUCCESS', success: <imageUrl string> }`.
5. `buildSubmitPayload(manifest, uploadedUrls)` 로 submit body 조립.
6. `POST /workspaces/:wid/mini-app/review` 로 create + review-request 동시 제출 (bundle `Xc` 함수 기준).

**--json 계약** (`runRegister` doc comment 가 source of truth):

| Exit | stdout 형태 |
|---|---|
| 0 | `{"ok":true,"workspaceId":3095,"appId":123,"reviewState":"PENDING"}` (success) or `{"ok":true,"dryRun":true,"workspaceId":3095,"payload":{...}}` (dry-run) |
| 2 | `{"ok":false,"reason":"no-workspace-selected"}` / `invalid-config` + `message` / `missing-required-field` + `field` + `message` / `image-dimension-mismatch` + `path`/`expected`/`actual`/`message` / `image-unreadable` + `path`/`message` / `terms-not-accepted` + `message` |
| 10 | `{"ok":true,"authenticated":false}` |
| 11 | `{"ok":false,"reason":"network-error","message":...}` |
| 17 | `{"ok":false,"reason":"api-error","status":400,"errorCode":...,"message":...}` |

**안전 장치**:

- **`--dry-run`**: 매니페스트 parse + 이미지 dimension 검증 + payload 조립까지 수행하고 submit body를 출력만 함. 업로드/제출 없음. `--accept-terms` 불필요. 실제 submit 전 확인용.
- **`--accept-terms`**: 실제 submit은 콘솔 UI의 필수 법적 동의 체크박스(공통 5개 + 카테고리 의존 추가 조항 — `VALIDATION-RULES.md` 참조)를 우회한다. 사용자가 명시적으로 `--accept-terms`를 지정하지 않으면 CLI는 submit을 거부하고 exit 2로 종료한다 (`terms-not-accepted`). 이 플래그는 사용자가 `VALIDATION-RULES.md` 혹은 콘솔 UI에서 해당 조항들을 읽고 동의한다는 **CLI-level 확약**이다 — 서버 payload에 담기지 않는다 (dog-food로 확인된 shape에 해당 필드 없음; 서버가 쿠키 기반 로그인 세션만 믿고 submit을 받아줌).

## 기술 스택

- **TypeScript** (ESM only, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- **tsdown** — Node용 dist 빌드 (`pnpm build`)
- **Bun** — 플랫폼별 standalone 바이너리 컴파일 (`bun build --compile`, `pnpm build:bin`). pnpm은 의존성 관리만.
- **citty** — CLI 프레임워크
- **vitest** — 테스트
- **pnpm** — 패키지 매니저 (10.33.0)
- **Biome** — lint + formatter (umbrella 공통)
- **Changesets** — 릴리즈 (Type A: npm publish + binary release)

## Build / Release

### Build pipeline

- **Dev 의존성 관리**: pnpm 10.33.0. `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **Node dist (npm 경로)**: `tsdown`으로 `dist/cli.mjs` + `.d.mts` 산출. `@ait-co/console-cli` npm 패키지가 이걸 싣는다.
- **플랫폼 바이너리**: `bun build --compile --target=<target>` via `scripts/build-bin.ts`, 출력은 `dist-bin/aitcc-<os>-<arch>[.exe]`. Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64` (Bun의 `windows-arm64` 지원이 아직 partial이라 제외).
- **버전 임베딩**: build-time define `AITCC_VERSION`이 `package.json`의 `version`을 읽어 tsdown / Bun 양쪽 경로에 주입.

### 명령어

```bash
pnpm build          # tsdown으로 dist/ (npm install -g 용)
pnpm build:bin      # Bun으로 dist-bin/ 플랫폼별 바이너리 (GitHub Releases 용)
pnpm dev            # watch 모드
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
pnpm format         # biome format --write .
```

### 배포 채널

사용자 설치 경로 3가지:

1. **GitHub Releases 바이너리** (primary) — `install.sh` one-liner로 플랫폼 감지 + 다운로드. Node 불필요. `$HOME/.local/bin/aitcc` (0755)에 설치. `AITCC_VERSION=v0.1.1`로 pin 가능.
2. **npm global** — `npm i -g @ait-co/console-cli`. `dist/cli.mjs`를 싣고 Node 24+ 런타임 필요. `agent-plugin`이 이 경로를 사용(개발 환경엔 보통 Node가 이미 있음).
3. **Homebrew tap** — deferred, 0.1.x 범위 밖.

**왜 바이너리가 primary인데도 npm publish 하는가?**
1. `agent-plugin`은 이미 Node를 PATH에 전제한다. npm 배포는 plugin이 `@ait-co/console-cli`를 peer로 선언하고 사용자가 기존 패키지 매니저로 설치하게 해준다 — skill 안에서 별도 installer를 설득할 필요 없음.
2. TypeScript consumer(장래 다른 org 툴의 programmatic 사용)가 `import type { DeployResult } from '@ait-co/console-cli'`를 할 수 있게. 별도 `@ait-co/console-cli-types` 패키지를 쪼갤 필요 없음.

두 경로는 Changesets로 동기화 — version bump는 한 번, `npm publish`와 바이너리 release가 같은 tag에서 돈다.

### Self-update (`aitcc upgrade`)

알고리즘:
1. `GET https://api.github.com/repos/apps-in-toss-community/console-cli/releases/latest` (공개 repo라 인증 불필요; 익명 rate limit 회피를 위해 `GITHUB_TOKEN` env 있으면 존중).
2. `tag_name`의 `v` 제거 후 임베드 버전과 비교. 같으면 "already up to date"로 exit 0. `--force`는 체크 우회.
3. 현재 실행 파일 경로 확인. Bun 컴파일 바이너리에선 `process.execPath`가 바이너리 자체. npm/Node에선 `process.execPath`가 `node`이므로 self-upgrade를 **거부**하고 `npm i -g @ait-co/console-cli@latest`를 안내.
4. 플랫폼/아키에 맞는 asset name 골라 `<exePath>.new.<timestamp>`로 다운로드.
5. **(계획됨, 현재 미구현)** `SHA256SUMS` asset으로 SHA-256 검증. 0.1.x 스캐폴드의 `src/commands/upgrade.ts`는 아직 이 단계를 수행하지 않는다 — TODO로 추적. (`install.sh`는 이미 검증한다.)
6. `chmod 0755` 후 **atomic replace**: `fs.renameSync(new, exePath)`. POSIX `rename(2)`은 동일 파일시스템에서 atomic. Windows는 실행 중인 exe를 rename할 수 없어서 `<exePath>` → `<exePath>.old`, `<new>` → `<exePath>`로 옮기고 `.old`는 다음 기동 때 정리("boot 시 stale `.old` 청소" 체크 — 현재는 `.old` 파일만 남기고 정리 로직은 미구현, TODO).
7. **(계획됨, 현재 미구현)** 새 바이너리를 `--version`으로 re-exec 해서 smoke test.

### `install.sh`

- `set -eu` / `uname -s` (`Linux`|`Darwin`) / `uname -m` (`x86_64`→`x64`, `arm64`/`aarch64`→`arm64`) / 바이너리 이름 `aitcc-<os>-<arch>`.
- Download: `releases/latest/download/<name>` + `SHA256SUMS`. `SHA256SUMS`에서 바이너리 이름에 해당하는 라인만 필터링 후 `shasum -a 256 -c` 또는 `sha256sum -c`로 검증 (둘 중 사용 가능한 쪽).
- 설치 위치: `${AITCC_INSTALL_DIR:-$HOME/.local/bin}`, `mkdir -p` → `chmod 0755` → `mv`. 설치 후 `command -v aitcc`가 비어 있으면 bash/zsh/fish용 `PATH` 추가 one-liner를 출력.
- 엣지 케이스 (TODO.md 참고): `shasum` 없을 때 `sha256sum` fallback, `$HOME` 없을 때 `/tmp` fallback, release asset 업로드 레이스에 대한 exp-backoff 30s 재시도, 기존 root 소유 바이너리 감지, `AITCC_QUIET=1`.

### Release flow (Type A per umbrella)

- `.changeset/` 활성.
- `.github/workflows/release.yml`의 `publish:` 입력은 **`pnpm exec changeset publish`** (raw `npm publish`가 아님 — `changesets/action`이 `🦋 New tag:` stdout 라인을 파싱해 GitHub Release를 만들기 때문. `@changesets/cli publish`만 그 라인을 emit한다).
- Trigger: `main`에서 "Version Packages" PR merge.
- `changesets/action`:
  1. `package.json` version bump + CHANGELOG 갱신 (이 단계는 Version Packages PR 생성 run).
  2. PR merge 후: `pnpm exec changeset publish` 호출 → 내부적으로 npm publish를 shell-out. `NPM_CONFIG_PROVENANCE=true` 환경변수가 provenance 서명을 활성화하고, OIDC token이 있으면 자동으로 trusted publishing 경로를 탄다.
  3. `🦋 New tag: v{x.y.z}` 라인을 파싱해 tag push + GitHub Release 생성 (`createGithubReleases: true`). Tag format은 single-package repo이므로 `v{version}`.
- **이어서** `release-binaries.yml`이 `release.published` 이벤트로 트리거 → Linux/macOS/Windows matrix 빌드 → 바이너리 + `SHA256SUMS` 생성 → `gh release upload`로 방금 만든 release에 asset 붙임. (이 체인이 돌려면 `GITHUB_TOKEN`이 **App token** — default `GITHUB_TOKEN`으로는 `release.published`가 firing되지 않는다.)
- `install.sh`는 `releases/latest`를 읽으므로, `AITCC_VERSION`으로 pin하지 않으면 항상 최신.

### Release policy

- **Type A** per umbrella (`../CLAUDE.md`의 "배포 전략"). npm publish + GitHub Release 바이너리 자동 업로드.
- 현재 **`0.1.x` patch only** 구간. minor/major는 Dave 명시 지시 시에만. 애매하면 patch로 추측하지 말고 확인.
- 다음 minor 이벤트는 곧바로 `1.0.0` (umbrella 규칙).
- Changesets 일상 흐름: PR 중 `/changeset` 호출 → `.changeset/*.md` 생성 (기본 patch) → merge → changesets/action이 "Version Packages" PR 생성 → Dave가 검토 후 merge → 릴리즈 파이프라인 발사.

## Open questions

- `deploy` dry-run 모드는 day one부터 — 모든 mutating command에 `--dry-run` 추가.

## macOS 바이너리 서명 (현행)

Bun-compiled 바이너리는 비표준 `LC_CODE_SIGNATURE` stub 때문에 Apple stock `codesign`이 `invalid or unsupported format for signature`로 거부하는 경우가 있다. `0.1.x`에서는 **ad-hoc 서명**을 적용하며, CI는 `rcodesign` (https://github.com/indygreg/apple-platform-rs) 을 사용한다.

- `scripts/build-bin.ts`가 `bun-darwin-*` 타겟에서: (1) `codesign --remove-signature`로 깨진 stub 제거 → (2) `rcodesign sign --entitlements-xml-path scripts/macos-entitlements.plist`로 ad-hoc 서명.
- `.github/workflows/release-binaries.yml`의 macOS 잡이 빌드 전에 `rcodesign` 0.29.0 바이너리를 다운로드.
- `install.sh`도 macOS 설치 후 `xattr -d com.apple.quarantine` + stock `codesign --sign -` 재-사인을 fallback으로 시도 (이때는 이미 서명이 있는 정상 Mach-O라 stock으로도 통과).

정식 Apple notarization (Developer Program $99/년)은 1.0 item. Bun 업스트림이 stub 생성을 고치면 rcodesign 의존성을 제거할 수 있으나 현재(1.3.13 기준)는 미확인 — TODO.md의 backlog에 추적.

## Status

`login` / `logout` / `whoami` / `upgrade` 모두 end-to-end 동작. `login`은 CDP로 시스템 Chrome을 띄워 세션 쿠키 캡처, `whoami`는 `members/me/user-info` 라이브 호출. `deploy` / `logs` / `status` 등 나머지는 TODO.md. 각 기능은 Playwright headed 세션으로 network tap 해서 endpoint + payload shape 파악 → pure `fetch()` 재현 방식으로 구현한다.

전체 로드맵은 [landing page](https://apps-in-toss-community.github.io/) 참고.
