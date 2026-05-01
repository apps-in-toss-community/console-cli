# Mini-apps · Bundles · Deployments

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

미니앱 번들(빌드 결과 zip/AIT)의 업로드, 검토, 배포 endpoint 묶음. 자세한 번들 포맷(AIT vs legacy zip)은 console-cli `CLAUDE.md`의 "App deploy" 섹션 참고.

> **Capture status note**: 이 도메인은 console-cli의 `app deploy` / `app bundles {ls, deployed, upload, review, release, test-push, test-links}` 명령군이 호출하지만, 본 inventory 작성 시점(2026-04-30)까지 **실제 응답 본문 캡처는 미보유** (sdk-example dog-food는 등록까지만 진행됨, 실제 번들 빌드/배포 사례 없음).
>
> 모든 path는 콘솔 번들 정적 분석(`bootstrap.*.js` grep, [`.playwright-mcp/ENDPOINTS-CATALOG.md`](https://github.com/apps-in-toss-community/.playwright-mcp/) 참고)으로 확인. 본문 shape은 [`src/api/mini-apps.ts`](../../src/api/mini-apps.ts), [`src/commands/app-deploy.ts`](../../src/commands/app-deploy.ts)의 inferred 모델 기준.

## 색인

### Bundles (번들)

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles` | 번들 목록 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/deployed` | 현재 배포된 번들 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/release` | 번들 릴리즈 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/reviews` | 번들 심사 요청 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/reviews/withdrawal` | 심사 철회 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/test-links` | 테스트 링크 생성 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/test-push` | 테스트 배포 (푸시) | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/bundles/memos` | 번들 메모 | ⚠️ |

### Deployments (배포 트랜잭션)

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/deployments/initialize` | 배포 초기화 (업로드 URL 발급) | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/deployments/complete` | 배포 완료 (uploaded 검증) | ⚠️ |

## 흐름 (CLI `app deploy` 기준)

CLI [`src/commands/app-deploy.ts`](../../src/commands/app-deploy.ts)가 묶는 단계:

1. **번들에서 `deploymentId` 자동 추출** — AIT 헤더 protobuf field 2 또는 legacy zip의 `app.json._metadata.deploymentId`. CLI 로컬 처리, 서버 콜 없음.
2. **`POST .../deployments/initialize`** — 응답으로 업로드용 pre-signed URL을 받음 (추정).
3. **번들 바이너리 업로드** — pre-signed URL로 직접 PUT.
4. **`POST .../deployments/complete`** — 업로드 완료를 서버에 알림. 응답으로 `bundleId` 등을 받음 (추정).
5. (옵션) **`POST .../bundles/reviews`** with `--request-review --release-notes <text>`.
6. (옵션) **`POST .../bundles/release`** with `--release --confirm` — bundle이 APPROVED 상태일 때만 동작.

## TODO: 본문 캡처 필요

이 도메인의 신뢰도를 ✅로 올리려면 다음 캡처가 필요하다:

- 콘솔 UI의 "배포 관리"/"빌드 이력" 페이지 driving하면서 `bundles` GET 호출 응답 본문.
- 실제 번들 업로드 흐름(initialize → S3-style upload → complete) 전체 XHR 시퀀스.
- 검토 요청 시 `reviews` POST의 request body shape (`releaseNotes` 외 다른 필드 있는지).
- 릴리즈 시 `release` POST의 request body / 응답.

각 endpoint를 캡처하면 이 파일을 endpoint별 항목으로 분해해 [`mini-apps.md`](./mini-apps.md)와 같은 형태로 채울 것. 현재는 path catalog + 흐름 설명만.
