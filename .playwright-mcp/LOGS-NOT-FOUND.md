# App Runtime Logs — Investigation (negative result)

**Date**: 2026-04-23
**Branch**: `feat/app-logs-investigation`
**Task**: Decide whether `aitcc app logs <id>` is implementable against the
current Apps-in-Toss developer console surface.

**Verdict**: No runtime-log endpoint exists. The console exposes **custom
analytics event catalogs** (aggregate counts + schema of events fired via
`app.logEvent()`) and **user reports**, but nothing that returns raw
stdout/stderr, exception stacks, or a per-request log stream. Task
deferred pending backend surface area — do not implement a speculative
command.

## What was searched

### 1. Complete endpoint inventory (static bundle analysis)

The console bundle (`bootstrap.N0Zaulo0.js`, 1.4 MB, fetched 2026-04-23)
declares every API call via a single `H(j.path("…").method("…").create())`
factory, so a plain grep yields the full surface. The live main hash was
found by decompressing the root HTML:

```sh
curl -s --compressed https://apps-in-toss.toss.im/ \
  | grep -oE '/static/[a-zA-Z0-9._/-]+\.js'
#  /static/main.7n9WVhZ8.js
curl -s --compressed https://apps-in-toss.toss.im/static/main.7n9WVhZ8.js \
  | grep -oE 'bootstrap\.[A-Za-z0-9_-]+\.js'
#  bootstrap.N0Zaulo0.js
curl -s --compressed https://apps-in-toss.toss.im/static/bootstrap.N0Zaulo0.js \
  | grep -oE '"/api-public/[a-zA-Z0-9/_.{}-]+"' \
  | sort -u | wc -l
#  184
```

**Of 184 total endpoints, the only ones with `/log/` in their path are three:**

| Method | Path | Purpose (from bundle query keys) |
| --- | --- | --- |
| POST | `…/mini-app/{id}/log/catalogs/search` | `getEventList` / `getEventListInfinite` — paged list of custom event *names* recorded for the app. Already wired as `aitcc app events`. |
| POST | `…/mini-app/{id}/log/details/search` | `getEventDetail` — the **schema** (param keys + types + description) of a single custom event, looked up by `logName`. Not a log stream. |
| PUT | `…/mini-app/{id}/log/details/update` | Event-schema editor (rename / edit param description). |

**`log/details/search` verified live**: `POST …/log/details/search {}`
returns `errorCode: "4000"` (validation error). Adding `{"logName":"screen"}`
switches to a server-side processing error (no such event for this app),
confirming `logName` is the expected key. If this endpoint streamed logs
it would not key on a schema name.

Separately grepped the bundle for every runtime-adjacent keyword:

```sh
grep -oE '"/[a-zA-Z0-9/_.{}-]*(runtime|telemetry|trace|monitor|stderr|stdout|crash|error-log|apm|diagnostic|event-stream)[a-zA-Z0-9/_.{}-]*"' bootstrap.N0Zaulo0.js
# (no matches)
```

### 2. UI route inventory

Extracted the full mini-app sub-page route map from
`bootstrap.N0Zaulo0.js`. The keys are Korean, one per sub-page the
console exposes to workspace owners:

```
생성, 홈, 공지사항, 신고내역, 평점및리뷰, 디자인, 기본정보상세, 기본정보설정,
토스로그인상세, 토스로그인설정, 서버인증서상세, 앱노출생성, 앱노출수정,
프로모션, 프로모션수정, 프로모션생성, 세그먼트리스트, 세그먼트생성,
메시지리스트, 메시지수정, 메시지상세, 인앱광고리스트, 인앱광고생성_v2,
인앱광고수정_v2, 인앱광고리스트_v2, 인앱결제상품리스트, 인앱결제상품생성,
인앱결제상품수정, 공유리워드리스트, 공유리워드생성, 공유리워드수정,
이벤트목록, 전환지표리스트, 전환지표생성, 스마트발송등록, 스마트발송리스트,
스마트발송상세, 스마트발송기능성생성, 스마트발송기능성수정, 스마트발송기능성상세
```

**None of these names correspond to runtime logs.** The closest labels
were checked directly:

- `이벤트목록` (`/mini-app/{id}/event/list`) — analytics event catalog, powered by `/log/catalogs/search`. Already wired as `aitcc app events`.
- `신고내역` (`/mini-app/{id}/report`) — user reports, NOT app error reports. Already wired as `aitcc app reports`.
- `홈` (`/mini-app/{id}/home`) — dashboard; no hidden log panel (shares the same endpoints already inventoried).

There is no "로그" (logs), "모니터링" (monitoring), "런타임" (runtime),
"크래시" (crash), "에러" (errors), or equivalent English route.

### 3. Async-loaded chunks

Pulled every `index.*.js` chunk referenced by bootstrap (55 chunks, fetched
individually into `/tmp/console-chunks/`). Greps:

```sh
grep -l 'log/catalogs\|log/details' /tmp/console-chunks/*.js
#  (no match — only bootstrap.js declares them)

grep -oE '(로그|Logs|LogList|runtime|telemetry|CrashLog|AppLog|ErrorLog)' /tmp/console-chunks/*.js
#  Every '로그' hit is the compound "로그인" (login),
#  specifically the "토스 로그인" (Toss Login) feature pages.
```

A chunk named `LoggingScreen.tnuR-XnT.js` exists but turns out to be a
1.4 KB HOC that fires client-side page-view telemetry for the console
itself (Sentry release tag baked in). Not a runtime-log UI.

### 4. Existing `.playwright-mcp/` captures

Checked the umbrella `apps-in-toss-community/.playwright-mcp/`
directory (279 prior captures from earlier dog-food sessions). The
`ENDPOINTS-CATALOG.md` already flagged the three `/log/*` endpoints
under a section literally titled "Logs", but the query-key evidence
above shows that section is mislabeled: they're **event catalog**
endpoints, not runtime logs. `25-app-detail-tabs.md` from an early
session speculated a "Logs" tab might exist at
`/mini-app/:appId/logs` — that file was captured with no registered
app and explicitly marked `NOT CAPTURED`; no such route exists in the
route table above.

## What would a log endpoint look like if we missed one?

To be useful for a `aitcc app logs --tail` command, it would need **any**
of:

- a Server-Sent Events / WebSocket path (`/events`, `/stream`, `/ws`) —
  none present;
- a paginated "log entry" GET with timestamp cursors (`/logs?since=`) —
  none present;
- a POST-with-filter log search with per-record timestamps + levels
  (`/log-search`, `/runtime/query`) — none present;
- a Sentry-style issue list — none present.

The conversation-facing `/log/details/search` is keyed on `logName` (a
schema identifier), not a timestamp range — so even if we stretched
"logs" to mean "analytics event occurrences", this endpoint doesn't
surface per-occurrence records, just the catalog-level schema.

## Recommendation

Do **not** ship a speculative `aitcc app logs` command. Reasons:

1. There is no server data to return — the CLI would need to invent an
   abstraction that maps to nothing.
2. The Apps-in-Toss runtime is a closed system; miniapp code runs
   inside the Toss app shell and the only observability surface exposed
   to workspace owners is **custom events the miniapp itself emits via
   `app.logEvent()`**, plus aggregated metrics. Raw runtime logs would
   be a separate backend that doesn't exist (or is gated to internal
   Toss staff, not workspace owners).
3. `agent-plugin`'s planned `/ait logs` skill can, for now, graceful-
   degrade to "use `aitcc app events ls` to see custom event counts,
   or `aitcc app metrics` for conversion metrics".

If/when a log endpoint appears — reprobe with the procedure in section
1 (bundle grep for new paths), and re-open the implementation branch.
