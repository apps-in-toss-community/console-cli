# API Keys

`<base>` = `https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole`

워크스페이스-scope의 Deploy Key(콘솔 UI 표기: "API 키") — 배포 자동화 등 용도. 미니앱-scope의 인증서(`certs`)와 별도. 자세한 인증서는 [`mini-app-misc.md`](./mini-app-misc.md) 참고.

세 endpoint 모두 콘솔 관리 페이지 chunk(`static/index.ZsA5htf8.js`)에서 추출했다 — 발급 사례 없이 minified bundle을 정독해 호출 컨벤션을 확정한 결과라 첫 번째 라이브 발급 응답으로 다시 한번 확인해야 한다 (`extra` envelope에 새 필드가 있을 수 있음, surface는 그대로 유지).

## 색인

| Method | Path | 용도 | 상태 |
|---|---|---|---|
| GET | `/workspaces/<wid>/api-keys` | 목록 | ✅ (빈 list 라이브 캡처 + 발급 후 shape는 bundle 추출) |
| POST | `/workspaces/<wid>/api-keys` | 발급 | ✅ (bundle 추출) |
| PUT | `/workspaces/<wid>/api-keys/<api_key_id>/disable` | 비활성화 | ✅ (bundle 추출) |

## `GET /workspaces/<wid>/api-keys` — 목록

- **Used by**: [`src/api/api-keys.ts#fetchApiKeys`](../../src/api/api-keys.ts), `aitcc keys ls`
- **Capture status**: 빈 list 라이브 캡처. 발급 후 entry shape(`{id, name, expireTs}`)은 콘솔 관리 페이지 컴포넌트(`ye` in `static/index.ZsA5htf8.js`)에서 직접 읽는 필드 목록을 추출 — 첫 라이브 발급으로 한 번 더 확인 필요.
- **Auth**: 세션 쿠키

### Response (빈 list)

```json
{
  "resultType": "SUCCESS",
  "success": []
}
```

### Response (발급된 키 있음)

콘솔 UI 컴포넌트가 entry에서 읽는 필드는 `id` / `name` / `expireTs` 셋뿐이다. **plaintext key는 list 응답에 없다** — 발급 시 한 번만 응답에 surface되며(`apiKey` 필드), 이후엔 회수 불가. (GitHub PAT, `gh auth token` 동일 패턴.)

```jsonc
{
  "resultType": "SUCCESS",
  "success": [
    {
      "id": "<api_key_id>",            // delete path에 그대로 들어감
      "name": "ci-deploy",              // 발급 시 사용자가 입력한 라벨 (≤16, ASCII)
      "expireTs": 1900000000000          // epoch ms, UI는 floor((expireTs-now)/86400000) D-N으로 렌더
      // 서버가 새 필드를 추가하면 client는 `extra`로 보존 (코드 참조)
    }
  ]
}
```

코드 ([`src/api/api-keys.ts#normalizeKey`](../../src/api/api-keys.ts))는 `id` / `name`에 대해 fallback chain (`apiKeyId`/`keyId`, `apiKeyName`/`keyName`/`description`)을 유지한다 — bundle은 read path만 증명할 뿐 서버가 보내는 정확한 키 이름은 라이브 발급 한 건으로 한 번 더 확인할 가치가 있다.

## `POST /workspaces/<wid>/api-keys` — 발급

- **Used by**: [`src/api/api-keys.ts#createApiKey`](../../src/api/api-keys.ts), `aitcc keys create`
- **Capture status**: bundle 추출 (`he` 컴포넌트의 mutation handler `j` + 응답 access `S.apiKey`). 첫 라이브 발급 시 `extra`에 어떤 추가 필드가 오는지 캡처해서 이 문서를 갱신할 것.
- **Auth**: 세션 쿠키

### Request body

```json
{
  "workspaceId": <wid>,
  "name": "ci-deploy",
  "target": {
    "isAll": true,
    "appNames": []
  }
}
```

- `name`: 사용자 입력 라벨. UI 가드는 1..16자 + "공백, 한글, 특수문자 제외" placeholder. CLI는 `^[A-Za-z0-9_-]+$`로 동일하게 게이트한다.
- `target.isAll: true` → `appNames`는 빈 배열로 명시 전송 (UI도 `[]`를 같이 보낸다 — 필드 자체를 생략하는 동작은 미확인이라 mirror).
- `target.isAll: false` → `appNames`는 mini-app slug(`appName`, kebab-case) 배열. 숫자 `miniAppId`가 **아니다**.

### Response

```jsonc
{
  "resultType": "SUCCESS",
  "success": {
    "apiKey": "<plaintext>"          // 한 번만 surface — list endpoint에 다시 안 옴
    // 서버가 같이 돌려주는 `id`/`expireTs` 등은 `extra`로 그대로 surface
  }
}
```

콘솔 UI는 발급 직후 `S.apiKey`를 화면에 노출하며 **"이 키는 한 번만 표시되니 복사해서 안전하게 보관해주세요"** 안내 문구를 같이 띄운다. CLI도 동일 contract: stdout에 plaintext 한 줄, stderr에 1회성 경고. 로그/`--verbose`에 절대 surface하지 않는다.

### 운영 인스턴스 (sdk-example dog-food)

sdk-example CI 배포에 쓰는 Deploy Key 1개가 운영 중이다 — **plaintext 값은 발급 시 한 번만 노출되므로 여기 적지 않는다.** metadata만:

| id | name | workspace | scope | expire |
|---|---|---|---|---|
| 6905 | `aitcc-sdk-ex-ci` | 3095 | `aitc-sdk-example` | 2027-05-18 |

plaintext는 sdk-example GitHub repo secret `AITCC_API_KEY`에만 산다 (`ait deploy --api-key`가 소비). 분실 시 `revoke` + `create` 재발급 후 secret 갱신.

## `PUT /workspaces/<wid>/api-keys/<api_key_id>/disable` — 비활성화

- **Used by**: [`src/api/api-keys.ts#disableApiKey`](../../src/api/api-keys.ts), `aitcc keys revoke`
- **Capture status**: bundle 추출 (`Git` endpoint constant + `ee({workspaceId, apiKeyId})` mutation in `ye` component).
- **Auth**: 세션 쿠키

### Request

`<api_key_id>` is the `id` from the list endpoint. No body — `PUT` with empty body.

### Response

```json
{ "resultType": "SUCCESS", "success": null }
```

UI는 응답 후 list query를 invalidate하므로 cli도 `revoke` 후엔 `ls`로 한 번 더 fetch해야 최신 상태를 본다.

## 보안 노트

- plaintext key는 발급 응답(`apiKey`)에서 단 한 번만 surface되고 list endpoint는 이를 echo하지 않는다. 분실 시 `revoke` + `create` 재발급이 유일한 경로다.
- 이 키 한 개로 워크스페이스의 배포 API에 접근할 수 있으므로 secret manager에 즉시 저장한다 (`aitcc keys create --json`로 받아 keychain/CI secret으로 파이프).
- 세션 쿠키 redaction 룰(`docs/api/_redaction.md`)이 그대로 적용된다 — `--json` 출력 외 어떤 경로(stderr, 로그, error message)에도 plaintext key를 노출하지 않는다.

## ait 프로파일 자동 저장

`aitcc keys create` 발급 즉시 `~/.ait/credentials`(mode `0600`, 상위 디렉토리 `0700`)에 `--name`과 동일한 이름의 프로파일로 저장된다. 저장이 완료되면 별도의 `ait token add` 없이 바로 사용 가능하다:

```sh
aitcc keys create --name ci-deploy
# stderr: Saved as ait profile "ci-deploy". Run: ait deploy --profile ci-deploy
ait deploy --profile ci-deploy ./bundle.ait
```

- `--save-profile <other>`: 프로파일 이름을 `--name`과 다르게 지정한다.
- `--no-save-profile`: 자동 저장을 건너뛰고 stdout에만 key를 출력한다. CI 파이프에서 외부 secret manager로 직접 주입할 때 사용한다.

파일 write 실패 시(디스크 권한 문제 등)에도 plaintext key는 stdout에 출력되고 exit 0이므로, 호출자가 다른 경로로 저장할 수 있다. 실패 상세는 stderr `Warning:` 줄로 emit되며 **plaintext key는 절대 포함되지 않는다**.
