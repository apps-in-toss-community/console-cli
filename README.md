# console-cli

**한국어** · [English](./README.en.md)

[![npm](https://img.shields.io/npm/v/@ait-co/console-cli)](https://www.npmjs.com/package/@ait-co/console-cli)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](https://github.com/apps-in-toss-community/console-cli/blob/main/LICENSE)

> 1.0 이전 단계 (`0.1.x`) — npm에 배포돼 있습니다. 인증·워크스페이스·미니앱 명령(번들 배포, 인증서 관리 포함)이 end-to-end로 동작하며, `app logs`는 백엔드 endpoint 확보 후 구현 예정입니다. 전체 명령 표면은 [진행 상황](#진행-상황) 참조.

`aitcc`는 앱인토스 개발자 콘솔을 자동화하는 커뮤니티 CLI입니다 — 브라우저로 한 번만 로그인하면 이후 작업은 셸이나 AI 코딩 에이전트가 headless 브라우저로 처리합니다.

## 설치

### 플랫폼 바이너리 (권장)

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | sh
```

installer가 OS(`uname -s`)와 아키텍처(`uname -m`)를 자동 감지해 최신 GitHub Release에서 알맞은 바이너리를 받고, `SHA256SUMS`로 검증한 뒤 `$HOME/.local/bin/aitcc`에 설치합니다. Node는 **필요 없습니다**.

특정 버전 고정:

```sh
curl -fsSL https://raw.githubusercontent.com/apps-in-toss-community/console-cli/main/install.sh | AITCC_VERSION=v0.1.42 sh
```

설치 경로를 바꾸려면 `AITCC_INSTALL_DIR=/custom/path` (기본 `$HOME/.local/bin`).

### npm (대체 경로)

PATH에 Node 24+가 이미 있다면:

```sh
npm i -g @ait-co/console-cli
# 또는: pnpm add -g @ait-co/console-cli
```

`agent-plugin`은 프로젝트에 Node가 이미 설치돼 있을 때 이 경로를 사용합니다.

## 빠른 사용법

```sh
aitcc --version          # 임베드된 버전 출력
aitcc login              # 인터랙티브: 이메일/비밀번호/저장 위치를 묻고 로그인
aitcc login --interactive   # headless 대신 visible-browser 강제
aitcc logout             # 로컬 세션 파일 삭제
aitcc logout --purge     # 저장된 자격증명도 함께 삭제 (`auth clear` 대체)
aitcc whoami             # 현재 로그인된 사용자 + 자격증명 출처 표시
aitcc whoami --offline   # API 호출 없이 캐시된 identity 사용
aitcc whoami --json      # 스크립트·에이전트용 machine-readable 출력
aitcc upgrade            # 최신 GitHub Release로 self-update (바이너리 설치만)
aitcc upgrade --dry-run  # 다운로드·교체 없이 업데이트 확인만
aitcc upgrade --force    # 버전이 같아도 최신 release 재설치
```

비대화 환경(CI, 스크립트)에서는 비밀번호를 직접 타이핑하지 말고 pipe로:

```sh
printf '%s' "$AITCC_PASSWORD" | aitcc login --email you@example.com --password-stdin --json
# 또는 환경 변수만 export하면 CLI가 알아서 읽습니다:
AITCC_EMAIL=you@example.com AITCC_PASSWORD=… aitcc login --json
```

`--save file`을 붙이면 자격증명이 `~/.config/aitcc/credentials.json`에 저장돼 다음 `aitcc login`이 prompt 없이 실행됩니다.

`aitcc upgrade`는 GitHub API anonymous rate limit을 피하려고 `GITHUB_TOKEN`을 존중합니다.

예정 명령은 `app logs` 입니다 (백엔드 endpoint 확보 후).

### 프로젝트 컨텍스트 (`aitcc.yaml`)

app·workspace 범위 명령(`app status`, `app deploy`, `app certs ls`, `keys ls` 등)은 `--workspace <id>` 플래그와 positional `<appId>`를 받지만, 프로젝트 루트에 `aitcc.yaml`(또는 `aitcc.json`)을 두면 CLI가 cwd부터 상위로 올라가며 찾아 자동 적용합니다.

```yaml
# aitcc.yaml
workspaceId: 12345
miniAppId: 67890
```

해상도 우선순위 (높은 것부터):

- **workspace**: `--workspace` 플래그 → `AITCC_WORKSPACE` env → yaml `workspaceId` → 세션 선택값 (`aitcc workspace use`)
- **mini-app**: positional/플래그 `<appId>` → `AITCC_APP` env → yaml `miniAppId`

각 명령은 어떤 값이 resolve됐는지 stderr에 한 줄 헤더로 출력합니다 (`--json` 모드에선 machine-readable 출력에 영향 없도록 생략):

```
[workspace: 12345 (from aitcc.yaml) · app: 67890 (from aitcc.yaml)]
```

탐색은 가장 가까운 `.git` 디렉토리에서 멈추고 `$HOME` 위로는 절대 안 갑니다. `--workspace`로 workspace를 명시하면 yaml의 `miniAppId`는 무시되지만(다른 workspace 소속일 수 있음) `AITCC_WORKSPACE` env는 yaml miniApp을 유지합니다.

`aitcc app register`가 성공하면 응답의 `miniAppId`가 resolve된 `aitcc.yaml`/`aitcc.json`에 write-back됩니다 (YAML 주석·키 순서 보존). 이후 명령은 `--app` 없이 동작합니다. `--dry-run`에선 write-back을 건너뛰고, 같은 id가 이미 박혀 있으면 silently no-op. 프로젝트 파일 자체가 없으면 새로 만들지 않고 stderr에 한 줄 hint만 띄웁니다.

처음 매니페스트를 만들 땐 `aitcc app init`으로 시작합니다. 필수 필드를 인터랙티브 prompt로 받고(workspace는 live API에서 가져온 목록에서 선택), 각 값을 `register`와 동일한 제약으로 검증합니다. optional 필드(`homePageUri`, `logoDarkMode`, `keywords`, `horizontalScreenshots`)는 주석 처리된 줄로 미리 깔립니다. 이미지 경로(`./assets/logo.png`, `./assets/thumbnail.png`, `./assets/screenshot-{1,2,3}.png`)는 placeholder로 적히니 `aitcc app register` 전에 `./assets/`에 실제 파일을 넣어둡니다. `init`은 인터랙티브 TTY를 요구하고, `--json`/non-TTY 실행은 `interactive-required` (exit 2)로 거부합니다.

```sh
mkdir my-app && cd my-app
aitcc app init           # 인터랙티브 prompt → ./aitcc.yaml
# (logo/thumbnail/screenshots를 ./assets/에 넣음)
aitcc app register       # 미니앱 생성 + miniAppId write-back
aitcc app status         # 플래그 없이 동작 — aitcc.yaml에서 컨텍스트 읽음
```

### 로그인 동작

`aitcc login`은 자격증명을 다음 순서로 찾습니다: `--email` + `--password` / `--password-stdin` 플래그 → `AITCC_EMAIL` + `AITCC_PASSWORD` 환경 변수 → 파일 backend(`~/.config/aitcc/credentials.json`) → (TTY 환경에서만) 인터랙티브 prompt. 자격증명을 확보하면 Chrome DevTools Protocol로 Chrome 계열 브라우저를 띄워 가능하면 headless로 로그인을 진행하고, main frame이 로그인 후 workspace 페이지에 도달할 때까지 기다립니다. 도달하면 CDP로 모든 쿠키(JS로는 못 보는 `HttpOnly` 인증 쿠키 포함)를 덤프해 로컬 세션 파일에 저장합니다. 브라우저는 종료 시 삭제되는 임시 `--user-data-dir`에서 실행되므로 일상 브라우저 프로필은 절대 건드리지 않습니다.

자격증명이 설정돼 있어도 visible-browser flow를 강제하려면 `--interactive`를 사용합니다 (계정 전환, step-up 인증 우회). 레거시 `aitcc auth set` / `auth clear` / `auth status`는 여전히 동작하지만 deprecation 경고를 emit합니다 — `aitcc login`(인터랙티브 prompt가 저장 옵션 제공), `aitcc logout --purge`, `aitcc whoami`를 사용하세요. 1.0에서 제거됩니다.

CLI는 OS 표준 위치(Google Chrome, Chromium, Microsoft Edge)에서 Chrome을 찾습니다. 다른 곳에 설치돼 있으면 `AITCC_BROWSER=/path/to/chrome`으로 실행 파일을 지정하고, 스테이징 환경을 가리키려면 `AITCC_OAUTH_URL`로 로그인 URL을 override합니다. `--timeout <초>`로 로그인 대기 시간을 조절합니다 (기본 300초).

## SSH / headless 환경에서 로그인

SSH 원격 세션이나 GUI가 없는 서버에서도 자격증명 저장이 동작합니다. 자격증명은 `~/.config/aitcc/credentials.json` (perm 0600)에 저장되며 SSH/CI 환경에서도 동일하게 작동합니다. 평문 저장이므로 디스크 암호화(FileVault, LUKS) 사용을 권장합니다.

```sh
aitcc login --save=file --email you@example.com --password-stdin
# → ~/.config/aitcc/credentials.json (perm 0600)에 저장
# 이후 SSH 환경에서 aitcc login이 이 파일을 읽어 headless 로그인을 진행합니다.
```

경로를 바꾸려면 `AITCC_CREDENTIAL_FILE` env var를 지정합니다.

**세션 export/import (KR IP 필요)**

Desktop에서 세션을 export해 SSH 환경에 주입하는 방법도 있습니다:

```sh
# Desktop (이미 로그인된 상태):
aitcc auth export --format env   # → AITCC_SESSION=... 출력

# SSH 환경에서:
AITCC_SESSION='...' aitcc app deploy ./bundle.ait --json
```

## 세션 저장

로컬 세션은 XDG 규약 경로에 mode `0600`으로 저장됩니다:

- Linux/macOS: `$XDG_CONFIG_HOME/aitcc/session.json` (fallback `~/.config/aitcc/session.json`)
- Windows: `%APPDATA%\aitcc\session.json`

상위 디렉토리는 mode `0700`으로 생성됩니다. 로그인 중 캡처된 쿠키는 **절대** 출력·로깅되지 않으며 `--verbose`에도 노출되지 않습니다 — `whoami`로 노출되는 건 `user.email`, `name`, workspace 요약뿐입니다.

plain `0600` 파일을 쓰는 설계 이유는 [CLAUDE.md](./CLAUDE.md) 참조.

## CI/CD 통합

워크플로의 일회성 실행(`aitcc app deploy` 등)을 위해 desktop에서 캡처한 세션을 runner에 주입합니다:

```sh
# Desktop (이미 로그인된 상태):
aitcc auth export --format env >> $GITHUB_ENV       # 또는 secret으로 저장
# CI ($AITCC_SESSION으로 secret 노출):
aitcc app deploy ./aitc-sdk-example.ait --json
```

`AITCC_SESSION`이 설정되면 모든 명령은 로컬 파일 대신 이 env var에서 세션을 읽습니다. env 모드에선 `logout` / `workspace use` 등의 write 경로가 비활성화돼 CI 호스트가 세션 파일을 절대 디스크에 떨어뜨리지 않습니다. blob을 disk에 영구 저장하고 싶다면 `aitcc auth import --from-env`를 쓰세요 (주로 desktop wipe 후 복구).

> **KR 전용**: 콘솔 세션 쿠키는 KR residential IP에 바인딩됩니다. 같은 `AITCC_SESSION` blob이 한국 머신에선 동작하지만 비KR egress(GitHub-hosted runner — Azure US/EU 포함)에선 `401` / `errorCode: 4010`으로 실패합니다. KR self-hosted runner를 쓰거나 직접 실행하세요. 자세한 내용은 [`docs/api/auth-session.md`](./docs/api/auth-session.md) 참조.

## 업데이트 알림

인터랙티브 실행 시 `aitcc`는 가끔 최신 release를 확인해 새 버전이 있으면 stderr에 한 줄 알림을 출력합니다. rate-limit 친화적:

- 명령을 아무리 자주 실행해도 24시간에 한 번만 네트워크 호출.
- 실패한 체크도 throttle 윈도우를 갱신하므로 네트워크 단절이나 GitHub 403이 분 단위로 루프되지 않음.
- Conditional GET (`If-None-Match`) — 304 응답은 anonymous rate-limit bucket을 소모하지 않음.
- stdout이 TTY가 아니거나, `--json`이 설정돼 있거나, `AITCC_NO_UPDATE_CHECK=1`이면 체크 자체를 건너뜀.

캐시 상태는 `$XDG_CACHE_HOME/aitcc/upgrade-check.json` (fallback `~/.cache/aitcc/upgrade-check.json`)에 저장됩니다.

## 기계 가독 출력 (`--json`)

모든 명령이 `--json`을 받습니다. 설정 시:

- 정상 출력은 stdout에 한 줄짜리 JSON document로.
- 모든 진단은 stderr에 plain text로.
- exit code는 명령별로 의미가 있고 문서화돼 있습니다 (`src/exit.ts` 참조).

`agent-plugin` skill은 항상 `--json`으로 shell out하고 stdout을 파싱합니다.

## 진행 상황

다음 명령군이 end-to-end로 동작합니다:

- 인증·세션: `login` / `logout` / `whoami` / `auth` (export/import)
- 워크스페이스: `workspace` / `members` / `me` / `notices`
- 미니앱: `app` — `init` / `ls` / `show` / `status` / `deploy` / `register` / `ratings` / `reports` / `metrics` / `events` / `messages` / `share-rewards`, `app bundles` (`ls`/`deployed`/`upload`/`review`/`release`/`test-push`/`test-links`), `app certs` (`ls`/`show`/`issue`/`revoke`)
- 그 외: Deploy Key 발급(`keys`), `upgrade`(self-update), `completion`(셸 자동완성)

`app logs`는 백엔드 endpoint 확보 후 구현 예정입니다. 전체 로드맵은 [organization landing page](https://aitc.dev/) 참조.

## Deploy Key 발급

배포 자동화를 위한 워크스페이스-scope 자격증명(Deploy Key)을 발급합니다.

```sh
aitcc keys create --name ci-deploy
```

키 발급 즉시 `~/.ait/credentials`에 `ci-deploy` 프로파일로 저장되므로, 별도 `ait token add` 단계 없이 바로 사용할 수 있습니다:

```sh
ait deploy --profile ci-deploy --location ./bundle.ait
```

stdout에는 plaintext 키 한 줄만 나옵니다 (파이프 친화적). stderr는 저장된 프로파일 이름을 확인해줍니다. CI 파이프에서 키를 외부 secret manager에 직접 주입할 때처럼 로컬 저장이 필요 없다면 `--no-save-profile`로 저장을 건너뜁니다:

```sh
aitcc keys create --name ci-deploy --no-save-profile | secret-tool store --label=… key password
```

프로파일 이름을 `--name`과 다르게 지정하려면 `--save-profile <other-name>`을 사용합니다. plaintext 키는 발급 시 한 번만 노출되며 목록 endpoint에서 다시 확인할 수 없습니다 — 분실 시 `aitcc keys revoke <id>`로 무효화하고 재발급합니다.

## Pre-commit hook

선택 사항이지만 권장합니다. clone 후 표준 pre-commit hook을 활성화하면 staged 파일에 `biome check`가 자동으로 돕니다 (push 전 빠른 피드백):

```sh
git config core.hooksPath .githooks
```

활성화하지 않아도 동일한 검사가 CI에서 강제 계층으로 실행되므로 PR 단계에서 lint 실패를 볼 수 있습니다.

---

커뮤니티 오픈소스 프로젝트입니다.
