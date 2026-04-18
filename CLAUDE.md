# CLAUDE.md

## 프로젝트 성격 (중요)

**`apps-in-toss-community`는 비공식(unofficial) 오픈소스 커뮤니티다.** 토스 팀과 제휴 없음. 사용자에게 보이는 산출물에서 "공식/official/토스가 제공하는/powered by Toss" 등 제휴·후원·인증 암시 표현을 **쓰지 않는다**. 대신 "커뮤니티/오픈소스/비공식"을 사용한다. 의심스러우면 빼라.

**특히 주의**: 이 CLI는 헤드리스 브라우저로 공식 콘솔을 자동화한다. 콘솔 UI가 바뀌면 셀렉터가 깨질 수 있음을 README에 명시하고, **"공식 API를 호출하는 것이 아님"**을 분명히 한다.

## 짝 repo

- **`sdk-example`** (downstream consumer) — console-cli가 완성되면 sdk-example을 **앱인토스 실제 미니앱으로 배포**(현재 GitHub Pages 배포에 더해)해서 E2E 검증. 이게 CLI의 주요 품질 게이트.
- **`agent-plugin`** — `/ait deploy`가 이 CLI를 shell out으로 호출. 또는 MCP server로 붙여서 agent가 직접 tool call 가능하게.

독립 실행 가능. 다른 repo 변경 없이 배포 가능.

## 프로젝트 개요

**console-cli** — 앱인토스 개발자 콘솔(웹 UI)을 CLI와 MCP server로 자동화.

### 동작 방식

1. 최초 실행 시 브라우저를 열어 사용자가 직접 로그인 (OAuth flow 따위가 없으므로 수동).
2. 세션 쿠키/스토리지를 **로컬에 암호화 저장** (`~/.config/ait-console-cli/` 등).
3. 이후 명령은 **headless 브라우저**(Playwright)로 저장된 세션을 로드해 실행.
4. `ait-console build | deploy | release | logs` 같은 subcommand 제공.
5. MCP server 모드로 실행하면 Claude Code / Codex / Cursor 등이 tool call로 사용 가능.

### 보안 고려

- 세션 토큰은 **절대 로그/stdout에 출력 금지**.
- `--verbose`도 민감 정보 redact.
- Playwright 스크린샷은 기본 off (디버그 시 opt-in).

## Status

placeholder 상태. 구현 전.

전체 로드맵은 [landing page](https://apps-in-toss-community.github.io/) 참고.
