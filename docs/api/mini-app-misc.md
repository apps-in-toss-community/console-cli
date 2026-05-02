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
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/certs` | 인증서 목록 | 🟢 |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/cert/issue` | 발급 (singular `cert`) | 🟢 |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/certs/<cert_id>/disable` | 비활성화 (plural `certs`) | 🟢 |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/bindable-clients` | bindable clients | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/review` | 토스 로그인 심사 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/encryption-key/email` | 암호화 키 이메일 발송 | ⚠️ |
| POST | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/marketing-agreement` | 마케팅 동의 | ⚠️ |
| GET | `/workspaces/<wid>/mini-app/<mini_app_id>/toss-login/with-draft` | 토스 로그인 설정 + draft | ⚠️ |

#### mTLS cert issue / disable / list (확정)

콘솔 SPA의 `index.Bw6JQUAu.js` (mTLS 인증서 페이지 chunk)를 정적 분석해 path · request · response shape를 모두 확정. CLI는 `aitcc app certs {ls,issue,revoke}`로 노출.

**Path quirk** — 발급만 singular `cert`, 그 외(list/disable)는 plural `certs`. 코드 한 줄 수준에서 잘못 쓰기 쉬우므로 endpoint 상수에 주석을 박아 둔다.

**Issue** — `POST /workspaces/<wid>/mini-app/<mini_app_id>/cert/issue`

Request body:

```json
{ "name": "<cert-display-name>" }
```

`name` validation: 콘솔 UI는 placeholder에 "공백, 한글, 특수문자 제외"로 안내하고, 빈 값이면 client에서 `인증서 이름을 입력해주세요.` 토스트로 reject (서버 호출 전). CLI는 이 동일 규칙을 client-side에서 강제한다.

Response body (Toss envelope `success`):

```jsonc
{
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...PEM...\n-----END PRIVATE KEY-----\n",
  "publicKey": "-----BEGIN CERTIFICATE-----\n...PEM...\n-----END CERTIFICATE-----\n"
}
```

**Private key는 이 응답에서만 노출된다** — list endpoint는 metadata(id/name/expireTs)만 돌려준다. 콘솔 UI는 응답을 받자마자 `<name>_private.key` + `<name>_public.crt` 두 파일로 zip을 빌드해 즉시 다운로드시킨다 (재발급 불가). CLI도 같은 정책: stdout으로 default leak 금지, `--out <dir>`에 `0600`으로 저장하거나 `--print-key`를 명시 opt-in해야 한다. 자세한 redaction 규칙은 [`_redaction.md`](./_redaction.md) "PEM material" 참고 (그쪽 파일에 본 절을 cross-link로 추가).

**Disable** — `POST /workspaces/<wid>/mini-app/<mini_app_id>/certs/<cert_id>/disable`

Request body: `{}` (빈 JSON). Response: 빈 body 또는 envelope `{resultType: 'SUCCESS', success: null}` — 캡처 시점엔 콘솔 UI 코드가 `mutateAsync`의 반환값을 쓰지 않기 때문에 정확한 `success` 필드 형태는 비결정적. CLI는 envelope만 확인하고 unwrap 결과를 폐기한다.

서버에서는 cert를 hard-delete하지 않고 비활성 상태로 표시한다 (button label도 "삭제"지만 endpoint는 `disable`). 명령 이름은 사용자 의도에 가까운 `revoke`로 노출한다 (CLI 사용자가 `disable` 단어를 보면 "다시 enable할 수 있나?"로 오해할 수 있음 — 콘솔 UI 자체에 reactivate 버튼은 없다).

**List** — `GET /workspaces/<wid>/mini-app/<mini_app_id>/certs`

Response body: array of cert metadata.

```jsonc
[
  {
    "id": "<cert_id>",          // disable 호출 시 path param으로 사용
    "name": "<display-name>",   // issue 시 보낸 그 name
    "expireTs": 1764115200000   // millis since epoch (콘솔 UI는 X일 만료까지 D-N badge로 표시)
    // 추가 field 가능 — opaque pass-through
  }
]
```

cert 페이지 chunk는 `id`/`name`/`expireTs`만 사용. 다른 field가 있어도 CLI가 신경 쓸 필요 없음.

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
4. Cert list 응답에서 cert 페이지가 안 쓰는 추가 field가 있는지 — 현재 schema는 콘솔 chunk가 참조하는 `id`/`name`/`expireTs`만 확정. 발급/비활성화 흐름은 위 "mTLS cert issue / disable / list" 섹션에 정착.

각 endpoint별 본문이 모이면 [`mini-apps.md`](./mini-apps.md) 형태로 분해.
