# Mini-apps · 기타 도메인

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

`app reports` / `app metrics` / `app events` / `app templates` / `app share-rewards` / `app messages` / `app ratings` 같은 운영성 명령군이 호출하는 endpoint 모음. 등록(`mini-apps.md`)과 배포(`mini-app-bundles.md`)에 속하지 않는 나머지.

> **Capture status note**: 대부분 inferred (코드 + 콘솔 정적 분석). PREPARE 상태 앱(sdk-example dog-food)에서는 거의 모든 응답이 빈 배열 + `cacheTime` 형태라 본문이 빈약함. 실 운영 데이터가 쌓인 워크스페이스에서 재캡처 필요.

## 색인

### Logs (이벤트 카탈로그/검색 — runtime stdout/stderr 아님)

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/log/catalogs/search` | 로그 카탈로그 검색 (`app.logEvent()` 키 목록) | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/log/details/search` | 로그 상세 검색 | ⚠️ |
| PUT | `/workspaces/<wid>/mini-app/<mini_app_id>/log/details/update` | 로그 상세 업데이트 | ⚠️ |

> **runtime 로그 아님**: 콘솔에는 server runtime stdout/stderr endpoint가 없다. 자세한 사정은 console-cli `CLAUDE.md`의 "App runtime logs: deferred" 참고. 위 `log/...`은 SDK `app.logEvent(name, props)`로 emit한 **커스텀 이벤트 카탈로그**다.

### Parameters (원격 config)

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/param/catalogs/search` | 파라미터 키 목록 검색 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/param/details/search` | 파라미터 값 검색 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/param/<paramsKey>/values/search` | 특정 키 값 검색 | ⚠️ |
| PUT | `/workspaces/<wid>/mini-app/<mini_app_id>/param/details/update` | 파라미터 업데이트 | ⚠️ |

### Analytics

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/analytics/au` | Active users | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/analytics/heartbeat` | 실시간 지표 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/analytics/retention` | 리텐션 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/conversion-metrics` | 전환 지표 목록 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/conversion-metrics/<metric_id>` | 특정 metric 조회 | ⚠️ |
| DELETE | `/workspaces/<wid>/mini-app/<mini_app_id>/conversion-metrics/<metric_id>` | 삭제 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/conversion-metrics/<metric_id>/main` | 메인 지정 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/conversion-metrics/feedback` | 피드백 | ⚠️ |

> **PREPARE 상태**: `app metrics`, `app events`는 빈 배열 + `cacheTime` (서버 캐시 ISO 타임스탬프)만 반환한다. 캡처용으론 부족.

### Certs / Toss-login

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/certs` | 인증서 목록 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/cert/issue` | 발급 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/certs/<cert_id>/disable` | 비활성화 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/bindable-clients` | bindable clients | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/review` | 토스 로그인 심사 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/encryption-key/email` | 암호화 키 이메일 발송 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/marketing-agreement` | 마케팅 동의 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/with-draft` | 토스 로그인 설정 + draft | ⚠️ |

### Reports (사용자 신고) — 유일한 plural path

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-apps/<mini_app_id>/user-reports` | 사용자 신고 목록 | ⚠️ |

> **Path 주의**: mini-app endpoint 중 **유일하게 `mini-apps` (plural)** 이다. 다른 detail endpoint들은 모두 singular `mini-app`. 코드/inventory 둘 다 헷갈리기 쉬운 지점.
>
> **Pagination 주의**: cursor-based (`{reports, nextCursor, hasMore}`). 다른 list들의 page-based(`{contents, totalPage, currentPage}` / `{items, paging}`)와 다름.

### Share rewards

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/share-reward?search=` | 공유 보상 캠페인 목록 | ⚠️ |

> **Quirk**: 서버가 `?search=`를 항상 기대한다. 비어 있어도 query param 자체는 포함해야 함. 안 보내면 서버가 4000.

### Smart message · Segments · Templates · Maintenance

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| (다수) | `/workspaces/<wid>/mini-app/<mini_app_id>/smart-message/...` | 스마트 메시지 | ❌ |
| (다수) | `/workspaces/<wid>/mini-app/<mini_app_id>/segments/...` | (앱-scope) 세그먼트 | ❌ |
| (다수) | `/workspaces/<wid>/mini-app/<mini_app_id>/templates/...` | 템플릿 | ❌ |
| (다수) | `/workspaces/<wid>/mini-app/<mini_app_id>/maintenance-jobs/...` | 점검 작업 | ❌ |

세부 path는 `bootstrap.*.js`에서 검색. CLI 첫 버전 범위 밖.

## TODO: 캡처 우선순위

운영 데이터 있는 워크스페이스에서 다음 우선순위로 캡처:

1. `app reports` cursor pagination shape (`{reports, nextCursor, hasMore}`).
2. `app events` log catalog 한 항목의 실 본문 (현재는 빈 배열만).
3. `app metrics` heartbeat/retention 실제 응답 (현재는 빈 배열).
4. Certs 발급된 후 list 응답 — apt-key list와 같은 fallback chain 정리.

각 endpoint별 본문이 모이면 [`mini-apps.md`](./mini-apps.md) 형태로 분해.
