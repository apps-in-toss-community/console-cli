# CLAUDE.md

## 프로젝트 성격

`apps-in-toss-community`는 **비공식(unofficial) 오픈소스 커뮤니티**다. 토스/앱인토스 팀과 제휴·후원·인증 관계 없음, 공식 프로젝트 아님. 사용자에게 보여지는 모든 산출물(README, UI 카피, 패키지 설명, 커밋/PR 메시지, 코드 주석 등)에서 "공식(official)", "토스가 제공하는", "앱인토스에서 만든", "powered by Toss" 같은 제휴·후원·인증 암시 표현은 금지. 대신 "커뮤니티(community)", "오픈소스", "비공식(unofficial)"을 쓴다. 의심스러우면 빼라.

**이 CLI 특유의 주의**: 헤드리스 브라우저로 콘솔을 자동화하지만 **공식 API를 호출하는 것이 아니다** — 공개 개발자 콘솔 UI를 사용자의 인증된 브라우저 세션으로 driving할 뿐이므로, 콘솔 UI가 바뀌면 셀렉터/엔드포인트가 깨질 수 있음을 README에 명시한다.

## 짝 repo

이 repo와 직접 관련된 짝:

- **`sdk-example`** (downstream consumer) — console-cli가 완성되면 sdk-example을 앱인토스 실제 미니앱으로 배포해 E2E 검증. CLI의 주요 품질 게이트.
- **`agent-plugin`** — `/ait deploy`, `/ait logs` 같은 skill이 **Bash로 이 CLI를 shell out** 호출. MCP wrapping 안 함. `--json` 출력으로 충분.

독립 실행 가능. 다른 repo 변경 없이 배포 가능.

## 프로젝트 개요

**console-cli** — 앱인토스 개발자 콘솔(웹 UI)을 CLI로 자동화.

### 동작 방식

1. 최초 실행 시 사용자의 시스템 Chrome(또는 Chromium-family)을 CDP로 spawn해 사용자가 직접 로그인.
2. 로그인 완료 감지 즉시 `Network.getAllCookies`로 HttpOnly 포함 세션 쿠키 전체를 로컬 XDG 경로(`$XDG_CONFIG_HOME/aitcc/session.json`, fallback `~/.config/aitcc/session.json`)에 `0600`으로 저장.
3. 이후 명령은 저장된 쿠키를 `Cookie:` 헤더로 직렬화해 `fetch()`로 콘솔 API 직접 호출. Playwright 등 브라우저 재기동 없음.
4. `agent-plugin`이 이 CLI를 Bash로 호출 (MCP wrapping 없음).

### 보안

- 세션 쿠키는 **절대 로그/stdout에 출력 금지**. `--verbose`도 민감 정보 redact.
- `whoami` 라이브 호출이 노출하는 건 `user.name` / `email` / `role` / `workspaces`뿐.
- Chrome은 ephemeral `--user-data-dir`에서 spawn → 사용자의 일상 브라우저 프로필과 완전히 격리. 세션 캡처 후 temp 디렉토리 삭제.

## 아키텍처

### Command surface (`citty`)

CLI는 [`citty`](https://github.com/unjs/citty) 기반. 이유: subcommand 트리, `--help`/`--version` 자동 생성, `bun build --compile`에 유리한 작은 bundle.

**커버 범위 (0.1.x)**: `login` / `logout` / `whoami` / `upgrade` / `completion` 루트 명령에 더해 리소스-스코프 subcommand:

- `app ls / show / status / register / deploy / ratings / reports / certs / metrics / share-rewards / messages / events / templates / categories / service-status` 및 `app bundles {ls, deployed, upload, review, release, test-push, test-links}`
- `workspace partner / terms / segments ls`
- `me terms`
- `notices ls / show / categories`

각 명령의 정확한 플래그·응답 shape는 `aitcc <cmd> --help`와 `src/commands/`가 source of truth — 표를 여기서 유지하면 갱신 비용이 크다. 새 명령을 추가할 때 `--json` 계약 + exit code를 함께 정의하고 dog-food 결과로 quirks 섹션을 갱신한다.

**Next**: `app logs` (deferred — 아래 "App runtime logs" 참조), 그 외 backlog 항목.

**Non-goals for 0.1.x**: 플러그인 시스템, multi-account switching, release-notes 생성. 모두 maintainer의 명시적 `minor`/`major` 승인 뒤에.

### API quirks (dog-food로 확정된 것)

> **Source of truth**: 콘솔 API endpoint 스펙·캡처된 본문·redaction 규칙은 [`docs/api/`](./docs/api/)에 도메인별로 분할 체크인. 이 섹션은 **새 명령을 짜기 전에 봐야 할 hot-list 요약**일 뿐, 본문은 `docs/api/`가 권위.

- **`app register` submit shape** — `POST /workspaces/:wid/mini-app/review`에 `{miniApp, impression}` nested wrapper + `impression.categoryIds: [number]`. "등록 + 심사 제출 원샷" — 별도 review-trigger 엔드포인트 없음. **dual-mode**: `miniApp.miniAppId` 부재 → create, 존재 → update. update는 `approvalType: REVIEW` 상태에선 `errorCode: 4046`으로 막힘 (운영팀 검수 결과 대기). `mini-app/.../review-withdraw` 같은 endpoint도 없음. 0.1.7에서 "flat + `categoryList: [{id}]`"로 regression한 적 있는데, `GET /mini-app/:id`가 **current view만** 반환하는 걸 draft 소실로 오해한 결과 (실제론 `/with-draft`로 읽으면 정상 persist). 상세 + 캡처: [`docs/api/mini-apps.md`](./docs/api/mini-apps.md) "Update mode" + "Drift history".
- **Plural vs singular path** — `app reports`만 `GET /mini-apps/:id/user-reports` (plural). 그 외 모두 singular `mini-app/:id/...`. `app service-status`는 `mini-app/:id/review-status` (singular) — workspace-level `mini-apps/review-status`와 구분. [`docs/api/mini-app-misc.md`](./docs/api/mini-app-misc.md) "Reports" 섹션.
- **`/with-draft` envelope** — `app status`는 `approvalType` + `current` + `rejectedMessage` + `draft` 조합으로 client-side derive. 서버 권위 상태가 필요하면 `app service-status` (`/review-status`). [`docs/api/mini-apps.md`](./docs/api/mini-apps.md) `with-draft` 항목.
- **Cursor vs page pagination** — `app reports`만 cursor-based (`{reports, nextCursor, hasMore}`), 나머지 list는 page-based (`{contents, totalPage, currentPage}` 또는 `{items, paging}`). `notices`는 또 1-indexed page (DRF). [`docs/api/_conventions.md`](./docs/api/_conventions.md) "Pagination" + 각 도메인 파일.
- **`app share-rewards` `?search=` 강제** — 서버가 `?search=`를 항상 기대, 비어도 param 자체는 포함해야 함. [`docs/api/mini-app-misc.md`](./docs/api/mini-app-misc.md) "Share rewards".
- **PREPARE 상태 앱** — `app metrics`, `app events`는 빈 배열 + `cacheTime` (서버 캐시 ISO 타임스탬프)만 반환. 본문 캡처가 빈약한 이유. [`docs/api/mini-app-misc.md`](./docs/api/mini-app-misc.md) "Analytics".
- **`notices`는 별도 호스트** — `api-public.toss.im/api-public/v3/ipd-thor`, hard-coded `workspaceId=129` (모든 유저 공유). 세션 쿠키(`.toss.im` 도메인)로 자동 인증. [`docs/api/notices.md`](./docs/api/notices.md).
- **`completion`** (CLI quirk, API 아님): citty엔 generator 없어서 정적 top-level + 한 단계 subcommand 매핑만 하드코딩 (`app bundles ls` 같은 3단계 이하는 셸 fallback).

### Exit codes

`src/exit.ts`에 중앙화. 각 command는 의미 있는 exit code를 약속하고 `--json` 계약과 함께 문서화한다. agent-plugin skill이 이 값으로 분기하므로 **기존 코드의 의미를 바꾸는 건 breaking change**.

### `--json` 계약

- 모든 command가 `--json` 지원.
- `--json` 설정 시: stdout은 **한 줄짜리 JSON document**, stderr는 plain text 진단 메시지.
- 기본 출력: stdout이 TTY면 색, 아니면 plain. `NO_COLOR` 존중.
- `agent-plugin` skill은 항상 `--json`으로 shell out하고 stdout을 파싱한다.

### Session storage

- **위치**: XDG Base Directory. `$XDG_CONFIG_HOME/aitcc/session.json` → fallback `~/.config/aitcc/session.json` (Linux/macOS), `%APPDATA%\aitcc\session.json` (Windows).
- **권한**: 디렉토리 `0700`, 파일 `0600`. Windows에선 mode 호출이 best-effort no-op, 유저 프로필 ACL에 의존.
- **Shape**: `{ schemaVersion: 2, user: { id, email, displayName }, cookies: CdpCookie[], origins: [], capturedAt, currentWorkspaceId? }`. `cookies`는 CDP `Network.getAllCookies` 응답 그대로 저장 → http 레이어가 `Cookie:` 헤더로 직렬화. v1 파일은 `readSession`이 자동으로 v2로 마이그레이트.

**왜 plain `0600` 파일 (vs OS keychain)?**

OS keychain은 native dependency라 `bun build --compile`이 플랫폼별로 깔끔하게 번들하지 못한다. XDG `0600` 파일은 첫 릴리즈의 pragmatic floor — `gh`/`gcloud`/`firebase` 모두 거쳐 온 형태. 나중에 마이그레이션 쉬움 (`cookies`/`origins`만 keychain으로). Backlog 아이템.

### Login 선택 근거 (CDP capture vs OAuth callback server)

**결정: CDP로 시스템 Chrome을 spawn해 사용자 로그인 완료 감지 후 쿠키 덤프.** 초기 스캐폴드는 localhost OAuth callback server였는데 다음 이유로 폐기됨:

- 공개된 `client_id=4uktpjgqd0cp9txybqzuxc2y6w0cuupb`에 등록된 redirect_uri는 production `apps-in-toss.toss.im/sign-up` 고정. `http://127.0.0.1:<port>/callback`은 허용되지 않음.
- 인증 쿠키는 **HttpOnly**라 브라우저 JS로 capture 불가능. 반드시 CDP 레벨에서 `Network.getAllCookies`를 호출해야 함.
- Playwright 번들(~300 MB)을 끌어오면 `bun build --compile` 사이즈가 무너짐. 시스템에 이미 설치된 Chrome/Edge/Chromium을 spawn해 CDP로 드라이빙 → **바이너리에 브라우저가 포함되지 않는다**.

흐름: `src/chrome.ts`가 OS별 Chrome 경로를 찾아 ephemeral `--user-data-dir`로 spawn → `src/cdp.ts`의 minimal CDP client(WHATWG WebSocket, 외부 의존 없음)가 `Page.frameNavigated` 구독 → 메인 프레임 URL이 `apps-in-toss.toss.im/workspace[/*]`에 도달하면 login 완료 → `Network.getAllCookies` → `src/api/me.ts`가 `/console/api-public/v3/appsintossconsole/members/me/user-info`로 liveness check → Chrome kill + user-data-dir 삭제.

agent-plugin 호환성: 인터랙티브 login은 skill 안에서 절대 호출하지 않고, `whoami --json`이 `authenticated: false`면 사용자에게 `aitcc login`을 직접 돌리라고 안내한다.

### 구현 세부

- **Chrome 탐지**: `chromeCandidates()`가 `$AITCC_BROWSER` → OS별 기본 경로(macOS는 `/Applications/*.app/Contents/MacOS/...`, Windows는 `PROGRAMFILES*/Google/Chrome/Application/chrome.exe`, Linux는 PATH 상의 `google-chrome`/`chromium`/`microsoft-edge`) 순으로 시도. 전부 실패 시 `ChromeNotFoundError` → exit 14.
- **WebSocket 의존성 없음**: Node 22+ / Bun 둘 다 `globalThis.WebSocket` 제공 → `ws` 패키지 사용 안 함. `bun build --compile`에 native peer 문제 없이 들어간다.
- **Toss 공용 envelope**: `src/api/http.ts`가 `{ resultType: 'SUCCESS'|'FAIL', success, error? }` 래퍼를 unwrap, 실패는 `TossApiError`(401 or `errorCode: '4010'`이면 `isAuthError === true`)로 변환.
- **Timeout**: `--timeout <sec>`(기본 300). 내부 타이머는 `unref()` 처리.
- **Logout**: 세션 파일 `unlink`. `ENOENT`면 "no active session"으로 exit 0 — idempotent.

### App registration (`aitcc app register`)

콘솔의 미니앱 등록 플로우(두 스텝짜리 마법사 + 5개 필수 동의 체크박스)를 **단일 매니페스트 파일**로 자동화한다. Submit shape는 위 "API quirks"의 `app register` 항목 참조.

**매니페스트 경로 resolution**:
1. `--config <path>` (상대 경로는 cwd 기준).
2. 아니면 `./aitcc.yaml` → `./aitcc.json` 순으로 auto-detect.
3. 매니페스트 내부의 이미지 경로는 **매니페스트 파일의 디렉토리 기준**으로 resolve.

**매니페스트 스키마** (`src/config/app-manifest.ts`):

```yaml
# Required
titleKo: SDK 레퍼런스           # 한국어 앱 이름
titleEn: SDK Reference          # 영어 앱 이름
appName: ait-sdk-example        # kebab-case slug
csEmail: support@example.com    # 고객문의 이메일
logo: ./assets/logo.png         # 600×600 PNG
horizontalThumbnail: ./assets/thumb.png   # 1932×828 PNG
categoryIds: [3882]             # >=1. ID 트리는 docs/api/impression.md (예: 3882 = 생활 > 정보)
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

이미지 dimension은 업로드 전에 로컬 검증 (`src/config/image-validator.ts`). 서버도 `?validWidth=W&validHeight=H` 쿼리로 하드 검증하지만, agent-plugin이 structured error를 받을 수 있도록 먼저 로컬에서 체크.

**실행 흐름**: 세션 로드 + workspace 확정 → 매니페스트 parse + validation → 이미지 dimension 검증(로컬) → 각 이미지 순차 업로드 (`POST /resource/:wid/upload?validWidth=W&validHeight=H` multipart, 응답은 `{ resultType: 'SUCCESS', success: <imageUrl string> }`) → `buildSubmitPayload(manifest, uploadedUrls)` → `POST /workspaces/:wid/mini-app/review` 로 create + review-request 동시 제출.

**안전 장치**:

- **`--dry-run`**: 매니페스트 parse + 이미지 dimension 검증 + payload 조립까지만. 업로드/제출 없음. `--accept-terms` 불필요.
- **`--accept-terms`**: 실제 submit은 콘솔 UI의 필수 법적 동의 체크박스(공통 5개 + 카테고리 의존 추가 조항)를 우회. 사용자가 명시적으로 지정하지 않으면 CLI는 submit을 거부하고 exit 2 (`terms-not-accepted`). **CLI-level 확약**일 뿐 서버 payload엔 담기지 않는다 — 서버는 쿠키 기반 세션만 믿고 submit을 받음. 서버 측 validation 규칙(field length, regex, image dimension, 글로벌 unique 등)은 [`docs/api/mini-apps.md`](./docs/api/mini-apps.md) "Server-side validation" 표 참조.

### App deploy (`aitcc app deploy`)

`bundles upload` (+ optional `review` + optional `release`)를 하나로 묶는 래퍼. `--deployment-id` 생략 시 번들에서 자동 추출 (`src/config/ait-bundle.ts`) — 두 포맷 모두 지원:

1. **AIT** (modern `@apps-in-toss/ait-format`): `AITBUNDL` magic + protobuf 헤더 + 내부 zip blob. `deploymentId`는 헤더 protobuf field 2에서 직접 읽음 (protobufjs 의존 없음).
2. **Legacy zip**: `PK` magic, `app.json._metadata.deploymentId` 추출 (fflate).

Magic bytes로 첫 8바이트에서 자동 분기. `--json` 출력에 `bundleFormat: 'ait' | 'zip'` 포함.

스텝 opt-in: `--request-review --release-notes <text>`로 review 추가, `--release --confirm`으로 release 추가. `--release`는 bundle이 이미 APPROVED일 때만 동작 — 일반적으로 두 번째 실행에서 사용. Partial failure 시 `uploaded`/`reviewed`/`released` 플래그를 JSON에 포함해 agent-plugin이 재시도 스텝을 판단.

`bundles upload`는 여전히 explicit `--deployment-id` 요구 (low-level); 자동 추출은 `app deploy` 래퍼에 위임.

## 기술 스택

공통 baseline: **Node 24 LTS**, **pnpm 10.33.0** (`packageManager` 고정), **TypeScript strict**, **Biome** (lint + formatter — ESLint/Prettier 사용 안 함, `suspicious.noExplicitAny: error`). Pre-commit hook은 source-controlled (`.githooks/pre-commit`)이며 contributor가 수동 활성화한다: `git config core.hooksPath .githooks`. CI `pnpm lint`가 실제 강제 계층, hook은 빠른 피드백 용도. Commit message는 Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).

이 repo 고유:

- **TypeScript** strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, ESM only
- **tsdown** — Node용 dist 빌드 (`pnpm build` → `dist/cli.mjs` + `.d.mts`)
- **Bun** — 플랫폼별 standalone 바이너리 (`bun build --compile`, `pnpm build:bin`). pnpm은 의존성 관리만.
- **citty** (CLI), **vitest** (테스트)

핵심 명령: `pnpm dev` (watch), `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:bin`, `pnpm lint[:fix]`. 전체는 `package.json` 참조.

## Build / Release

이 repo는 **Type A**: npm 패키지 + Changesets 풀스택 (changeset → Version Packages PR → merge → publish + GitHub Release). 버전 정책: `0.1.x` (patch만) 단계 유지, 다음 minor 이벤트는 곧바로 `1.0.0`. patch는 자율 생성 OK, minor/major는 명시 지시 시만.

### 배포 채널

1. **GitHub Releases 바이너리** (primary) — `install.sh` one-liner, Node 불필요. `$HOME/.local/bin/aitcc` (0755). `AITCC_VERSION=v0.1.1`로 pin 가능.
2. **npm global** — `npm i -g @ait-co/console-cli`. Node 24+ 런타임. `agent-plugin`이 이 경로 사용.
3. **Homebrew tap** — deferred, 0.1.x 범위 밖.

**왜 바이너리가 primary인데도 npm publish?** (1) `agent-plugin`은 이미 Node를 PATH에 전제 → npm 배포로 peer dep 선언 가능. (2) TypeScript consumer가 `import type { DeployResult } from '@ait-co/console-cli'` 가능 → 별도 `*-types` 패키지 불필요. 두 경로는 Changesets로 동기화.

### 빌드 파이프라인

- **Node dist**: `tsdown`으로 `dist/cli.mjs` + `.d.mts`. `@ait-co/console-cli` npm 패키지가 싣는다.
- **플랫폼 바이너리**: `bun build --compile --target=<target>` via `scripts/build-bin.ts`, 출력은 `dist-bin/aitcc-<os>-<arch>[.exe]`. Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64` (Bun의 `windows-arm64` 지원이 partial이라 제외).
- **버전 임베딩**: build-time define `AITCC_VERSION`이 `package.json`의 `version`을 tsdown / Bun 양쪽 경로에 주입.

### Release pipeline (이 repo 고유 부분)

- `.github/workflows/release.yml`의 `publish:` 입력은 **`pnpm exec changeset publish`** (raw `npm publish` 아님 — `changesets/action`이 `🦋 New tag:` stdout 라인을 파싱해 GitHub Release를 만들고, `@changesets/cli publish`만 그 라인을 emit).
- **이어서** `release-binaries.yml`이 `release.published` 이벤트로 트리거 → Linux/macOS/Windows matrix 빌드 → 바이너리 + `SHA256SUMS` 생성 → `gh release upload`. 이 체인이 돌려면 `GITHUB_TOKEN`이 **App token** — default `GITHUB_TOKEN`으로는 `release.published`가 firing되지 않는다.
- `install.sh`는 `releases/latest`를 읽으므로 `AITCC_VERSION` pin 안 하면 항상 최신.
- ⚠️ **Version Packages PR merge 타이밍**: merge 후 `release.yml` 완료까지(~1분) 다른 feat/fix PR merge 금지. 동시 merge 시 release run이 다음 commit을 checkout한 시점에 새 `.changeset/*.md`가 남아 있어 `publish` 분기 대신 "PR 업데이트" 분기를 탐 → npm publish + GitHub Release 생성 skip (재현: 2026-04-23 v0.1.13, PR #54 직후 #55 merge). 복구는 다음 Version Packages PR merge가 누적 changeset을 한번에 publish — skip된 버전은 npm에 존재하지 않으므로 소비자 영향 없음, 다만 CHANGELOG 정정 필요.

### Self-update (`aitcc upgrade`)

알고리즘:
1. `GET https://api.github.com/repos/apps-in-toss-community/console-cli/releases/latest` (공개 repo, 익명 rate limit 회피용으로 `GITHUB_TOKEN` env 존중).
2. `tag_name`의 `v` 제거 후 임베드 버전과 비교. 같으면 "already up to date"로 exit 0. `--force`는 체크 우회.
3. 현재 실행 파일 경로 확인. Bun 컴파일 바이너리에선 `process.execPath`가 바이너리 자체. npm/Node에선 `process.execPath`가 `node`이므로 self-upgrade를 **거부**하고 `npm i -g @ait-co/console-cli@latest`를 안내.
4. 플랫폼/아키에 맞는 asset name 골라 `<exePath>.new.<timestamp>`로 다운로드.
5. 같은 release의 `SHA256SUMS` asset을 fetch → `parseSha256Sums`로 `<hex>  <name>` 라인 파싱 → 자기 binary line의 expected hash 추출 → staging 파일을 streaming `sha256OfFile`로 해시 → 비교. asset 부재/엔트리 부재/불일치 시 staging 파일 unlink + `ExitCode.UpgradeChecksumFailed` (22). `install.sh`와 동일 게이트, opt-out 없음.
6. `chmod 0755` 후 **atomic replace**: `fs.renameSync(new, exePath)`. POSIX `rename(2)`은 동일 파일시스템에서 atomic. Windows는 실행 중인 exe rename 불가 → `<exePath>` → `<exePath>.old`, `<new>` → `<exePath>`로 옮기고 `.old`는 다음 기동 때 정리 (정리 로직 자체는 미구현, TODO).
7. 새 binary로 `--version` 호출(timeout 10초). exit 0 + stdout 비공백이면 통과 → 백업 unlink 후 정상 종료. 실패 시 exit `UpgradeSmokeTestFailed` (23)으로 종료하면서 자동 롤백 시도:
   - POSIX: replace 직전에 `<exe>.bak.<ts>`로 copy해 둔 백업을 `rename(backup, exe)`으로 되돌림.
   - Windows: 새 `<exe>` 삭제 + `<exe>.old`를 `<exe>`로 rename.
   - 롤백 자체가 실패하면 JSON에 `rollbackError`와 백업 경로를 담아 사용자에게 수동 복구 hint 제공.

### `install.sh`

- `set -eu` / `uname -s` (`Linux`|`Darwin`) / `uname -m` (`x86_64`→`x64`, `arm64`/`aarch64`→`arm64`) / 바이너리 이름 `aitcc-<os>-<arch>`.
- Download: `releases/latest/download/<name>` + `SHA256SUMS`. 바이너리 라인만 필터링 후 `shasum -a 256 -c` 또는 `sha256sum -c`로 검증.
- 설치 위치: `${AITCC_INSTALL_DIR:-$HOME/.local/bin}` → `mkdir -p` → `chmod 0755` → `mv`. 설치 후 `command -v aitcc`가 비어 있으면 bash/zsh/fish용 `PATH` 추가 one-liner 출력.
- 엣지 케이스: `shasum`/`sha256sum` fallback, `$HOME` 없을 때 `/tmp` fallback, release asset 업로드 레이스에 exp-backoff 30s 재시도, 기존 root 소유 바이너리 감지, `AITCC_QUIET=1`.

### macOS 바이너리 서명

Bun-compiled 바이너리는 비표준 `LC_CODE_SIGNATURE` stub 때문에 Apple stock `codesign`이 `invalid or unsupported format for signature`로 거부하는 경우가 있다. `0.1.x`는 **ad-hoc 서명**으로 우회, CI는 [`rcodesign`](https://github.com/indygreg/apple-platform-rs) 사용:

- `scripts/build-bin.ts`가 `bun-darwin-*` 타겟에서 (1) `codesign --remove-signature`로 깨진 stub 제거 → (2) `rcodesign sign --entitlements-xml-path scripts/macos-entitlements.plist`로 ad-hoc 서명.
- `.github/workflows/release-binaries.yml`의 macOS 잡이 빌드 전에 `rcodesign` 0.29.0 다운로드.
- `install.sh`도 macOS 설치 후 `xattr -d com.apple.quarantine` + stock `codesign --sign -` 재-사인을 fallback (이때는 이미 정상 Mach-O라 stock으로도 통과).

정식 Apple notarization (Developer Program $99/년)은 1.0 item. Bun 1.3.13에서 stub 생성이 업스트림 수정됐고 toolchain은 `package.json`의 `engines.bun`으로 1.3.13에 핀돼 있다 — rcodesign 의존성 제거는 후속 PR에서 새 서명 경로를 E2E 검증한 뒤 진행 (backlog).

## 운영 메모

### 왜 top-level `aitcc status`가 없는가

초기 TODO에는 `aitcc status [appId]`가 루트-레벨로 올라와 있었지만, command surface를 쌓아 본 뒤 **`aitcc app status <id>`만 두고 루트 alias는 안 만들기로 결정**:

- CLI 조직 원칙은 **리소스-스코프 subcommand** (`app`, `workspace`, `me`, `notices`). 루트 alias는 이 원칙을 깨고 다른 리소스에도 alias를 만들자는 선례를 남긴다.
- 세션 상태(`session.json`)는 `currentWorkspaceId`만 기억하고 `currentAppId`는 의도적으로 안 기억. 인자 없는 `aitcc status`를 지원하려면 "선택된 앱" mode-state가 필요한데 UX 이득보다 관리 비용이 크다 (앱 삭제 시 dangling state, multi-app workflow 혼동).
- 인자 요구 alias는 `aitcc app status <id>` 대비 4글자만 절약 → 중복 surface + 추가 테스트 + 문서 항목을 정당화 못 함.

`deploy`/`logs`도 같은 원칙. 루트 도입 원할 때 "왜 지금은 다른가"를 이 섹션에 추가하는 것이 기본 안.

### App runtime logs: deferred (엔드포인트 없음)

콘솔 UI에는 서버 런타임 로그 엔드포인트가 노출되지 않는다. 콘솔이 surface하는 건 커스텀 이벤트 카탈로그(`app events` → `/log/catalogs/search`, `app.logEvent()` 집계)와 전환 지표(`app metrics` → `/conversion-metrics`)뿐. 원시 runtime 로그(stdout/stderr, 예외 스택, 요청별 라인)는 아니다. 전체 콘솔 번들(`bootstrap.*.js`)에 `runtime`/`telemetry`/`trace`/`crash`/`error-log`/`stream` 경로가 하나도 선언돼 있지 않고, `/mini-app/:id/` 서브페이지 route table에도 "로그" 메뉴 없음 — endpoint catalog는 [`docs/api/mini-app-misc.md`](./docs/api/mini-app-misc.md) "Logs" 섹션 (`/log/catalogs/...`, `/log/details/...`은 모두 커스텀 이벤트, runtime 아님). `aitcc app logs`는 backend surface area가 생길 때까지 deferred.

## Status

`login` / `logout` / `whoami` / `upgrade`는 end-to-end 동작. App/workspace/me/notices 명령군은 위 "Command surface" 참조. 새 기능은 Playwright headed 세션으로 network tap 해서 endpoint + payload shape 파악 → pure `fetch()` 재현 방식으로 구현.

전체 로드맵은 [landing page](https://apps-in-toss-community.github.io/) 참고.

## Contributing

이슈/제안은 GitHub Issues로.
