# TODO

## Console feature inventory (exploration pass 1 — 2026-04-21)

Apps in Toss 콘솔을 Playwright로 로그인 후 훑어 확인한 API 표면. 모든 endpoint의 base는 `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/`. 응답은 공통 envelope `{resultType: 'SUCCESS'|'FAIL', success, error}`.

### Authentication & identity

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `members/me/user-info` | 로그인 유저 + 접근 가능한 워크스페이스 목록 | ✅ 사용 중 (`whoami`) |
| GET | `console-user-terms/me` | 유저 약관 동의 상태 | 미사용 |

### Workspaces (multi-tenant root)

콘솔은 **하나의 계정이 여러 워크스페이스에 속할 수 있다**. `workspaceId`는 URL path로만 전달되며(`/workspace/:id/...`), 헤더/바디에는 실리지 않는다. CLI도 동일하게 `--workspace <id>` 플래그 혹은 `aitcc workspace use <id>`로 컨텍스트를 유지하도록 설계한다.

| Method | Path | 용도 |
|---|---|---|
| GET | `workspaces` | 참여 중인 워크스페이스 목록 |
| GET | `workspaces/invited` | 초대받은(미수락) 워크스페이스 |
| GET | `workspaces/:id` | 워크스페이스 상세 (사업자 등록·인증 상태 포함) |
| GET | `workspaces/:id/members` | 워크스페이스 멤버 목록 |
| GET | `workspaces/:id/members/me` | 현재 유저의 워크스페이스 역할(OWNER/…) |
| GET | `workspaces/:id/api-keys` | 워크스페이스 API 키 목록 |
| GET | `workspaces/:id/configs` | 워크스페이스 설정 |
| GET | `workspaces/:id/mini-app` | 미니앱 목록 |
| GET | `workspaces/:id/mini-apps/review-status` | 미니앱 심사 상태 요약 |
| GET | `workspaces/:id/console-workspace-terms/:termType/skip-permission` | 기능별 약관 건너뛰기 권한 (`BIZ_WORKSPACE`, `IAA`, `IAP`, `TOSS_LOGIN`, `TOSS_PROMOTION_MONEY`) |

### Mini-app detail (추가 탐색 필요)

워크스페이스 3095(프로덕트팩토리)에는 실제 등록된 미니앱이 없어서 app detail 이하 endpoint는 아직 실트래픽으로 확인되지 않았다. UI 경로와 추정 패턴만 기록해둠:

- 경로 추정: `workspaces/:id/mini-app/:appId` (단수 `mini-app`) + `/deployments`, `/versions`, `/logs`, `/statistics` 등이 붙을 가능성
- 확인 방법: sdk-example을 프로덕트팩토리 워크스페이스에 등록한 뒤(아래 High Priority 참고) 다시 Playwright 탐색 2차 수행

### External (not under console API prefix)

| Method | URL | 용도 |
|---|---|---|
| GET | `business-wallet.toss.im/api-public/v3/business-wallet/business-dashboard/wallets/summary` | 비즈월렛 요약 (header `key-biz-user-no` 필요) |

### UI action 목록 (buttons observed, XHR 미수집)

각 탭에서 UI 버튼으로만 확인된 action. GET endpoint는 위 표에 있고, 아래는 **쓰기 action**이라 클릭하지 않음. 해당 기능을 CLI로 구현하려면 실제 한 번 UI로 수행하며 Playwright로 XHR을 캡처해야 한다.

- **앱 탭**: `+ 등록하기`(앱 생성)
- **멤버 탭**: `초대하기` (member invite)
- **API 키 탭**:
  - `연동 키 → 등록` (예: 토스페이 가맹점 키 — 외부 서비스 연동용)
  - `콘솔 API 키 → 발급받기` — **이게 CLI deploy 흐름의 공식 경로**. 콘솔 API 키로 할 수 있는 건 **배포 API 호출뿐**, 그 외 기능은 세션 쿠키 필요 (Dave 확인). 아직 발급 전이라 관리 페이지가 404.
- **비즈월렛**: 외부 도메인 (`business-wallet.toss.im`) — CLI out of scope
- **내 정보**: 사업자 정보 편집 — 민감해 CLI out of scope

### CLI 자동화 가능성 요약

- ✅ **바로 구현 가능 (read-only, 확정 endpoint)**: `workspace ls/use/show`, `app ls`, `members ls`, `review-status`, `whoami`
- ⚠️ **UI action 실제 수행 + XHR 재캡처 후 구현**: `app create`(+등록하기), `members invite`(초대하기), `deploy`(콘솔 API 키 경유), `keys create`(발급받기) + 그 이후 `logs`, `versions`, `stats`(앱 등록된 상태에서)
- ❌ **out of scope (1.0까지)**: 약관 동의/변경, 비즈월렛, 사업자 정보 편집 — 민감하거나 UI 흐름이 복잡함

### Raw exploration artifacts

`/Users/dave/Projects/github.com/apps-in-toss-community/.playwright-mcp/` 하위에 저장된 snapshot·XHR 로그 참조 (로컬 전용, repo 커밋 안 됨).

## High Priority

- [ ] **Register `sdk-example` as a real mini-app in workspace 3095 (프로덕트팩토리).** UI에서 수동 등록 flow를 한 번 거치면서 Playwright로 XHR 캡처 → app detail/deploy/logs/stats API를 실트래픽으로 확정. dog-fooding 측면에서도 umbrella 로드맵 상의 마일스톤(모든 repo가 sdk-example로 수렴).
- [ ] **`aitcc workspace ls/use/show`** — 워크스페이스 컨텍스트 관리. `~/.config/aitcc/session.json`에 `currentWorkspaceId` 필드 추가(schemaVersion bump), 모든 이후 명령은 이 값을 기본으로 쓰고 `--workspace <id>` 오버라이드 허용.
- [ ] **`aitcc app ls`** — 현재 워크스페이스의 미니앱 목록. 심사 상태(`review-status`)도 join해 `Name | AppId | Status` 테이블로 출력. `--json`도 필수.
- [ ] **`aitcc deploy [path]`** — sdk-example 등록 후 API 확정되면 구현. `--dry-run`은 day one부터.

## Medium Priority

- [ ] **`aitcc logs [--tail]`** — app-level 로그. sdk-example 등록 후 endpoint 확정 필요.
- [ ] **`aitcc status [appId]`** — 앱별 상태 + 최신 배포 요약. review-status + mini-app detail 조합.
- [ ] **`aitcc members ls / invite <email> / remove <id>`** — 워크스페이스 멤버 관리. invite는 UI `초대하기` flow 한 번 실행해 XHR 캡처 후 구현. remove/권한변경은 UI에 노출돼있지 않아 별도 탐색 필요.
- [ ] **`aitcc keys ls / create`** — 콘솔 API 키 목록/발급. 발급 후 관리 페이지 XHR도 재탐색 필요(현재 키 없어 404).
- [ ] **`aitcc app create <name>`** — `+ 등록하기` flow 자동화. sdk-example 등록을 이 명령으로 하는 게 dog-fooding의 정점.
- [ ] Wire SHA-256 verification into `aitcc upgrade` — download `SHA256SUMS` from the release, verify the binary before atomic replace (currently only `install.sh` verifies). `src/commands/upgrade.ts` ~L135.
- [ ] Wire smoke test after upgrade — re-exec the new binary with `--version` before considering the upgrade successful.
- [ ] Clean up stale `<exePath>.old` files on Windows boot (currently left behind after self-upgrade).
- [ ] Audit `--json` error paths — `src/commands/upgrade.ts` writes JSON errors to stdout while plain errors go to stderr; the CLAUDE.md contract wants **diagnostics on stderr always**, with only the structured result on stdout.

## Low Priority

- [ ] **Workspace init wizard** — `aitcc init` 같은 명령으로 sdk-example에서 확인한 등록 flow를 CLI로 자동화. API가 확정된 뒤 별도 마일스톤.
- [ ] Self-host the CLI docs (alongside the `docs` repo or as a subpath).
- [ ] Extend `install.sh` platform coverage — `/tmp` fallback when `$HOME` is unset, and exponential-backoff retry (up to 30 s) on 404 during the release-asset upload race. (`sha256sum` fallback, root-owned prior-install detection, and `AITCC_QUIET=1` are already implemented.)
- [ ] Clean up stale `.tmp` siblings under `$XDG_CACHE_HOME/aitcc/` left by a SIGKILL/power-loss crash between `writeFile(tmp)` and `rename(tmp, final)` in `update-check.ts`. Each file is <200 bytes so accumulation is cosmetic, but a "drop `.tmp` older than 7 days" sweep at the top of `writeCache` would be a one-screen fix. Only do this if a user reports it or if we start writing larger cached bodies.

## Notes on session schema

The current schema (`schemaVersion: 1`) stores CDP-native cookies in `cookies: CdpCookie[]`. Pre-CDP sessions written by the old OAuth-callback scaffold had `cookies: []` and no auth material, so they read back as "session exists but any live API call 401s" — the user is prompted to re-run `login`. Pre-1.0, no back-fill is needed; on `1.0` we'll bump `schemaVersion` if the shape ever changes.

Workspace context(`currentWorkspaceId`)는 schemaVersion 2로 올릴 때 추가한다. 마이그레이션은 "필드 없으면 처음 `workspace use` 호출 시 생성" 한 줄이면 충분.

## Performance

- [ ] Binary size (~60 MB on Bun 1.3.12). `--minify --sourcemap=none` is already on in `scripts/build-bin.ts` but only shaves ~2 MB — the remaining ~58 MB is the bundled Bun runtime floor. Realistic levers, from lowest to highest rewrite cost:
  - UPX-compress the release asset (~60 MB → ~20 MB). Trade-offs: ~0.5–1 s startup decompression, some AVs flag UPX binaries, and the macOS ad-hoc signature has to be reapplied AFTER `upx` (UPX rewrites the Mach-O). Worth a dedicated experimental PR once there's demand.
  - Switch runtime to Deno compile / Node SEA / @yao-pkg/pkg — all still 50–80 MB; not worth the migration.
  - Rewrite in Go / Rust / Zig — 2–5 MB binary, rewrite cost is everything. 1.0+ item.

## Backlog

- [ ] **Revisit `rcodesign` dependency** — the release pipeline downloads rcodesign 0.29.0 on every macOS job because stock `codesign` has historically rejected Bun-compiled binaries with `invalid or unsupported format for signature`. Upstream probed as of Bun 1.3.13 (2026-04-20): the regression is acknowledged in issues like [oven-sh/bun#29276](https://github.com/oven-sh/bun/issues/29276), [#29120](https://github.com/oven-sh/bun/issues/29120), [#29306](https://github.com/oven-sh/bun/issues/29306), and [#29361](https://github.com/oven-sh/bun/issues/29361) (still open). Locally on 1.3.12 + macOS 26.x, `codesign --remove-signature` followed by `codesign --sign - --force` succeeds — but only after the strip step, and robustness across all targets is unverified. Action: when a future Bun release explicitly calls out the Mach-O / LC_CODE_SIGNATURE fix in its blog, re-run the release-binaries matrix without rcodesign and delete the rcodesign install step + CLAUDE.md note.
- [ ] OS keychain session storage (macOS Keychain / Windows Credential Manager / Secret Service) behind a flag — blocked by `bun build --compile` not bundling native deps like `keytar` cleanly across platforms. Can be added later without migrating data: move `cookies`/`origins` into the keychain, keep the rest in `session.json`.
- [ ] `aitcc mcp` — expose the same ops as an MCP stdio server. Deferred per the umbrella MCP strategy matrix.
- [ ] macOS binary signing / notarization — users currently `chmod +x` and `xattr -d com.apple.quarantine` if Gatekeeper complains. Proper notarization is a 1.0 item.
- [ ] Homebrew tap (`brew install apps-in-toss-community/tap/aitcc`).
- [ ] Plugin system, multi-account switching, release-notes generation — out of scope for 0.1.x; gated behind explicit `minor`/`major` approval.
