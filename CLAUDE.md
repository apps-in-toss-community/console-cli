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

1. 최초 실행 시 브라우저를 열어 사용자가 직접 로그인.
2. 세션 쿠키/스토리지를 로컬 XDG 경로(`$XDG_CONFIG_HOME/ait-console/session.json`, fallback `~/.config/ait-console/session.json`)에 `0600`으로 저장.
3. 이후 명령은 headless Playwright로 저장된 세션을 로드해 실행.
4. `ait-console whoami | upgrade`가 MVP. `login | deploy | logs | status`는 TODO.md 참고.
5. `agent-plugin`이 이 CLI를 Bash로 호출 (MCP wrapping 없음).

### 보안 고려

- 세션 토큰(쿠키/origins)은 **절대 로그/stdout에 출력 금지**. `--verbose`도 민감 정보 redact.
- `whoami`가 노출하는 건 `user.email` / `displayName`만.
- Playwright 스크린샷은 기본 off (디버그 시 opt-in).

## 아키텍처

### Command surface (`citty`)

CLI는 [`citty`](https://github.com/unjs/citty) 기반. 이유: subcommand 트리, `--help`/`--version` 자동 생성, UnJS 생태계와의 궁합. 큰 의존성(oclif 등) 대비 bundle size가 작아 `bun build --compile`에 유리.

MVP (0.1.x scaffold에서 다룬 범위):

| Command | Status | Purpose |
| --- | --- | --- |
| `ait-console --version` | ✅ | build time에 `package.json`의 `version`을 `AIT_CONSOLE_VERSION` define으로 주입. |
| `ait-console --help` | ✅ | `citty` 자동 생성. |
| `ait-console whoami` | ✅ | 로컬 세션에서 현재 로그인 유저 표시. 세션 없으면 non-zero exit. 세션 모듈의 첫 실제 consumer. |
| `ait-console upgrade` | ✅ | GitHub Releases latest 조회 → 임베드 버전과 비교 → 플랫폼/아키 바이너리 다운로드 → atomic 교체. |

Next (tracked in TODO.md, 이 scaffold 단계에는 없음): `login`, `logout`, `deploy [path]`, `logs [--tail]`, `status`, (deferred) `mcp`.

**Non-goals for 0.1.x**: 플러그인 시스템, multi-account switching, release-notes 생성. 모두 Dave의 명시적 `minor`/`major` 승인 뒤에.

### Exit codes

`src/exit.ts`에 중앙화. 각 command는 의미 있는 exit code를 약속하고 `--json` 계약과 함께 문서화한다. agent-plugin skill이 이 값으로 분기하므로 **기존 코드의 의미를 바꾸는 건 breaking change**.

### `--json` 계약

- 모든 command가 `--json` 지원.
- `--json` 설정 시: stdout은 **한 줄짜리 JSON document**, stderr는 plain text 진단 메시지.
- 기본 출력: stdout이 TTY면 색, 아니면 plain. `NO_COLOR` 존중.
- `agent-plugin` skill은 항상 `--json`으로 shell out하고 stdout을 파싱한다.

### Session storage

- **위치**: XDG Base Directory. `$XDG_CONFIG_HOME/ait-console/session.json` → fallback `~/.config/ait-console/session.json` (Linux/macOS), `%APPDATA%\ait-console\session.json` (Windows).
- **권한**: 디렉토리 `0700`, 파일 `0600`. `fs.mkdir({ mode: 0o700 })` + `fs.writeFile({ mode: 0o600 })`. Windows에선 mode 호출이 best-effort no-op, 유저 프로필 ACL에 의존.
- **Shape**: `schemaVersion: 1`, `user`, `cookies`, `origins`, `capturedAt`. `cookies`/`origins`은 Playwright `storageState` 그대로.

### Session storage 선택 근거 (plain `0600` vs keychain)

**현재: plain `0600` 파일.** 근거:

- OS keychain (`keytar`, Windows Credential Manager, Secret Service)은 **네이티브 의존성**이라 `bun build --compile`이 플랫폼별로 깔끔하게 번들하지 못한다. 현재 Bun 기준 cross-platform 지원이 불완전.
- XDG 디렉토리 안 `0600` 파일은 첫 릴리즈의 **pragmatic floor**. `gh`/`gcloud`/`firebase` CLI 모두 과거에 거쳐 온 형태.
- **나중에 keychain으로 마이그레이션이 쉬움**: `cookies`/`origins`만 keychain으로 옮기고 나머지는 `session.json`에 남긴다. 기존 데이터 migration 없음. Backlog 아이템.

### Login 선택 근거 (localhost callback vs copy-paste)

**결정: localhost callback server + PKCE-style one-shot code capture.** (0.1.x 스캐폴드에는 stub만 있음.)

- `login`은 `server.listen(0)`으로 ephemeral port에 HTTP 서버를 띄우고, Toss OAuth URL을 `redirect_uri=http://127.0.0.1:<port>/callback`과 random `state`로 열어 callback을 기다린 뒤 `state` 검증 → 서버 종료 → 세션 기록.
- **Copy-paste code를 쓰지 않는 이유**: UX가 실제로 더 나쁨(focus 잃음, 잘못된 토큰 붙여넣기). 보안 경계가 사용자가 code를 복사한 앱으로 옮겨감. `127.0.0.1` localhost callback은 `gh auth login --web`, `gcloud auth login`, `firebase login`이 모두 쓰는 바로 그 패턴이고, 시크릿을 **single-use redirect**로 좁힌다.
- **agent-plugin 호환성**: `login`은 agent-plugin skill이 **절대** 호출하지 않는다. plugin은 `whoami --json`이 세션 없음을 보이면 deploy를 거부하고, 사용자에게 터미널에서 직접 `ait-console login`을 돌리라고 안내한다. 인터랙티브 단계를 agent 바깥으로 뺀다.

## Build / Release

### Build pipeline

- **Dev 의존성 관리**: pnpm 10.33.0. `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **Node dist (npm 경로)**: `tsdown`으로 `dist/cli.mjs` + `.d.mts` 산출. `@ait-co/console-cli` npm 패키지가 이걸 싣는다.
- **플랫폼 바이너리**: `bun build --compile --target=<target>` via `scripts/build-bin.ts`, 출력은 `dist-bin/ait-console-<os>-<arch>[.exe]`. Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64` (Bun의 `windows-arm64` 지원이 아직 partial이라 제외).
- **버전 임베딩**: build-time define `AIT_CONSOLE_VERSION`이 `package.json`의 `version`을 읽어 tsdown / Bun 양쪽 경로에 주입.

### 기술 스택

- **TypeScript** (ESM only, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- **tsdown** — Node용 dist 빌드 (`pnpm build`)
- **Bun** — 플랫폼별 standalone 바이너리 컴파일 (`bun build --compile`, `pnpm build:bin`). pnpm은 의존성 관리만.
- **citty** — CLI 프레임워크
- **vitest** — 테스트
- **pnpm** — 패키지 매니저 (10.33.0)
- **Biome** — lint + formatter (umbrella 공통)
- **Changesets** — 릴리즈 (Type A: npm publish + binary release)

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

1. **GitHub Releases 바이너리** (primary) — `install.sh` one-liner로 플랫폼 감지 + 다운로드. Node 불필요. `$HOME/.local/bin/ait-console` (0755)에 설치. `AIT_CONSOLE_VERSION=v0.1.1`로 pin 가능.
2. **npm global** — `npm i -g @ait-co/console-cli`. `dist/cli.mjs`를 싣고 Node 24+ 런타임 필요. `agent-plugin`이 이 경로를 사용(개발 환경엔 보통 Node가 이미 있음).
3. **Homebrew tap** — deferred, 0.1.x 범위 밖.

**왜 바이너리가 primary인데도 npm publish 하는가?**
1. `agent-plugin`은 이미 Node를 PATH에 전제한다. npm 배포는 plugin이 `@ait-co/console-cli`를 peer로 선언하고 사용자가 기존 패키지 매니저로 설치하게 해준다 — skill 안에서 별도 installer를 설득할 필요 없음.
2. TypeScript consumer(장래 다른 org 툴의 programmatic 사용)가 `import type { DeployResult } from '@ait-co/console-cli'`를 할 수 있게. 별도 `@ait-co/console-cli-types` 패키지를 쪼갤 필요 없음.

두 경로는 Changesets로 동기화 — version bump는 한 번, `npm publish`와 바이너리 release가 같은 tag에서 돈다.

### Self-update (`ait-console upgrade`)

알고리즘:
1. `GET https://api.github.com/repos/apps-in-toss-community/console-cli/releases/latest` (공개 repo라 인증 불필요; 익명 rate limit 회피를 위해 `GITHUB_TOKEN` env 있으면 존중).
2. `tag_name`의 `v` 제거 후 임베드 버전과 비교. 같으면 "already up to date"로 exit 0. `--force`는 체크 우회.
3. 현재 실행 파일 경로 확인. Bun 컴파일 바이너리에선 `process.execPath`가 바이너리 자체. npm/Node에선 `process.execPath`가 `node`이므로 self-upgrade를 **거부**하고 `npm i -g @ait-co/console-cli@latest`를 안내.
4. 플랫폼/아키에 맞는 asset name 골라 `<exePath>.new.<timestamp>`로 다운로드.
5. `SHA256SUMS` asset으로 SHA-256 검증.
6. `chmod 0755` 후 **atomic replace**: `fs.renameSync(new, exePath)`. POSIX `rename(2)`은 동일 파일시스템에서 atomic. Windows는 실행 중인 exe를 rename할 수 없어서 `<exePath>` → `<exePath>.old`, `<new>` → `<exePath>`로 옮기고 `.old`는 다음 기동 때 정리("boot 시 stale `.old` 청소" 체크).
7. 새 바이너리를 `--version`으로 re-exec 해서 smoke test.

### `install.sh`

- `set -eu` / `uname -s` (`Linux`|`Darwin`) / `uname -m` (`x86_64`→`x64`, `arm64`/`aarch64`→`arm64`) / 바이너리 이름 `ait-console-<os>-<arch>`.
- Download: `releases/latest/download/<name>` + `SHA256SUMS`. 검증 `grep " $NAME$" SHA256SUMS | shasum -a 256 -c -`.
- 설치 위치: `${AIT_CONSOLE_INSTALL_DIR:-$HOME/.local/bin}`, `mkdir -p` → `chmod 0755` → `mv`. 설치 후 `command -v ait-console`가 비어 있으면 bash/zsh/fish용 `PATH` 추가 one-liner를 출력.
- 엣지 케이스 (TODO.md 참고): `shasum` 없을 때 `sha256sum` fallback, `$HOME` 없을 때 `/tmp` fallback, release asset 업로드 레이스에 대한 exp-backoff 30s 재시도, 기존 root 소유 바이너리 감지, `AIT_CONSOLE_QUIET=1`.

### Release flow (Type A per umbrella)

- `.changeset/` 활성.
- Trigger: `main`에서 "Version Packages" PR merge.
- `changesets/action`:
  1. `package.json` version bump + CHANGELOG 갱신.
  2. `npm publish --provenance --access public`.
  3. GitHub Release 생성, tag `@ait-co/console-cli@x.y.z`.
- **이어서** `release-binaries.yml`이 Linux/macOS/Windows matrix 빌드 → 바이너리 + `SHA256SUMS` 파일 생성 → `gh release upload`로 방금 만든 release에 asset 붙임.
- `install.sh`는 `releases/latest`를 읽으므로, `AIT_CONSOLE_VERSION`으로 pin하지 않으면 항상 최신.

### Release policy

- **Type A** per umbrella (`../CLAUDE.md`의 "배포 전략"). npm publish + GitHub Release 바이너리 자동 업로드.
- 현재 **`0.1.x` patch only** 구간. minor/major는 Dave 명시 지시 시에만. 애매하면 patch로 추측하지 말고 확인.
- 다음 minor 이벤트는 곧바로 `1.0.0` (umbrella 규칙).
- Changesets 일상 흐름: PR 중 `/changeset` 호출 → `.changeset/*.md` 생성 (기본 patch) → merge → changesets/action이 "Version Packages" PR 생성 → Dave가 검토 후 merge → 릴리즈 파이프라인 발사.

## Open questions

- `login`이 실제로 사용자를 어느 페이지에 떨구는가? 개발자 콘솔 로그인 페이지 URL과 OAuth scope는 아직 discovery 중. 그때까지 `login`은 stub 유지.
- macOS 바이너리 서명? 0.1.x에서는 안 함. 사용자가 `chmod +x` + `xattr -d com.apple.quarantine`로 우회. 제대로 된 notarization은 1.0 item.
- `deploy` dry-run 모드는 day one부터 — 모든 mutating command에 `--dry-run` 추가.

## Status

scaffold 완료 (`whoami`/`upgrade` 동작, `login` stub). 나머지 command는 TODO.md 참고.

전체 로드맵은 [landing page](https://apps-in-toss-community.github.io/) 참고.
