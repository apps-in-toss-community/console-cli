#!/usr/bin/env bun
// THROWAWAY SPIKE — see CI-COOKIE-SPIKE-RESULT.md.
// Verifies whether a desktop-captured console session cookie set is usable
// from a different process / UA / IP. Not wired into the CLI.
//
//   Local run:    bun run scripts/ci-cookie-spike.ts
//   CI run:       AITCC_COOKIE_BLOB=<base64-json> bun run scripts/ci-cookie-spike.ts
//
// The script must NEVER print cookie values or anything from the auth
// payload. Anything written to stdout/stderr or under spike-output/ci/ is
// safe-to-share (cookie names + metadata only).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FetchLike, requestConsoleApi, TossApiError } from '../src/api/http.js';
import type { CdpCookie } from '../src/cdp.js';
import { sessionFilePath } from '../src/paths.js';

const SPIKE_DIR = 'spike-output/ci';
const RESPONSES_PATH = join(SPIKE_DIR, 'responses.jsonl');
const SHAPE_PATH = join(SPIKE_DIR, 'cookie-shape.json');

const ME_URL =
  'https://apps-in-toss.toss.im/console/api-public/v3/appsintossconsole/members/me/user-info';

const CI_LIKE_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface PhaseRecord {
  readonly phase: 'A' | 'B' | 'C' | 'D';
  readonly label: string;
  readonly status: number | 'NETWORK_ERR' | 'SKIPPED';
  readonly errorCode?: string;
  readonly isAuthError?: boolean;
  readonly successKeys?: readonly string[];
  readonly userEmailHash?: string;
  readonly notes?: string;
}

async function main(): Promise<void> {
  await mkdir(SPIKE_DIR, { recursive: true });
  // Reset previous run so nothing stale leaks into the report.
  await writeFile(RESPONSES_PATH, '', { mode: 0o600 });

  const cookies = await loadCookies();
  await writeCookieShape(cookies);

  const records: PhaseRecord[] = [];

  // ---- Phase A: baseline using session.json directly via the http helper ----
  records.push(await runPhase('A', 'baseline (session.json, default UA)', cookies, {}));

  // ---- Phase B: cookies-only (drop session metadata, use raw fetch) ----
  // Phase A already uses only `cookies` from session.json (the http helper
  // never reads anything else), so B is functionally identical. We still
  // run it through a different code path — direct fetch with a hand-built
  // Cookie header — to confirm there's no hidden coupling to session shape.
  records.push(
    await runPhaseRawFetch('B', 'cookies-only (raw fetch, default UA)', cookies, {
      // No User-Agent override → bun's default UA.
    }),
  );

  // ---- Phase C: change User-Agent to a Linux/Chrome (CI-runner-like) string ----
  records.push(
    await runPhaseRawFetch('C', 'cookies-only (raw fetch, CI-like Linux UA)', cookies, {
      'User-Agent': CI_LIKE_UA,
    }),
  );

  // ---- Phase C2: also send Origin/Referer matching the console ----
  // If the console requires Origin/Referer enforcement we want to know.
  records.push(
    await runPhaseRawFetch(
      'C',
      'cookies-only (raw fetch, CI-like UA, with Origin+Referer)',
      cookies,
      {
        'User-Agent': CI_LIKE_UA,
        Origin: 'https://apps-in-toss.toss.im',
        Referer: 'https://apps-in-toss.toss.im/console/',
      },
    ),
  );

  // ---- Phase D: blob round-trip ----
  // Two encodings, both decoded back into the same shape and replayed.
  // If AITCC_COOKIE_BLOB is set (CI), use that — otherwise round-trip locally.
  const blobSource = process.env.AITCC_COOKIE_BLOB;
  if (blobSource) {
    const decoded = decodeCookieBlob(blobSource);
    records.push(
      await runPhaseRawFetch('D', `env-blob (${decoded.length} cookies, default UA)`, decoded, {}),
    );
    records.push(
      await runPhaseRawFetch('D', `env-blob (${decoded.length} cookies, CI-like UA)`, decoded, {
        'User-Agent': CI_LIKE_UA,
      }),
    );
  } else {
    // Local round-trip: confirm both encodings preserve auth.
    const blob = encodeCookieBlobBase64(cookies);
    const reBlob = decodeCookieBlob(blob);
    records.push(
      await runPhaseRawFetch(
        'D',
        `local round-trip (base64 JSON blob, ${reBlob.length} cookies)`,
        reBlob,
        {},
      ),
    );
    const minimal = encodeCookieBlobMinimal(cookies);
    const reMinimal = decodeCookieBlob(minimal);
    records.push(
      await runPhaseRawFetch(
        'D',
        `local round-trip (minimal name=value, ${reMinimal.length} cookies)`,
        reMinimal,
        {},
      ),
    );
  }

  await summarise(records);
}

async function loadCookies(): Promise<readonly CdpCookie[]> {
  const path = sessionFilePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    fail(`could not read session file at ${path} — run 'aitcc login' first`);
  }
  const parsed = JSON.parse(raw) as { cookies?: CdpCookie[] };
  if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
    fail('session.json has no cookies — re-login');
  }
  return parsed.cookies;
}

function fail(msg: string): never {
  process.stderr.write(`spike: ${msg}\n`);
  process.exit(1);
}

// ---- Phase runners ----

async function runPhase(
  phase: 'A' | 'B' | 'C' | 'D',
  label: string,
  cookies: readonly CdpCookie[],
  headers: Record<string, string>,
): Promise<PhaseRecord> {
  const fetchImpl: FetchLike = (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...init?.headers, ...headers },
    });
  try {
    const me = await requestConsoleApi<Record<string, unknown>>({
      url: ME_URL,
      cookies,
      fetchImpl,
    });
    const userEmailHash = hashStringPrefix(me.email as string | undefined);
    const rec: PhaseRecord = {
      phase,
      label,
      status: 200,
      successKeys: Object.keys(me).sort(),
      ...(userEmailHash !== undefined ? { userEmailHash } : {}),
    };
    await appendRecord(rec);
    log(`phase ${phase}: ${label} → 200 (keys: ${rec.successKeys?.join(',')})`);
    return rec;
  } catch (err) {
    return await captureError(phase, label, err);
  }
}

// Direct fetch path with hand-built Cookie header — bypasses requestConsoleApi
// to confirm it's the cookies (not the helper) doing the work.
async function runPhaseRawFetch(
  phase: 'A' | 'B' | 'C' | 'D',
  label: string,
  cookies: readonly CdpCookie[],
  extraHeaders: Record<string, string>,
): Promise<PhaseRecord> {
  const url = new URL(ME_URL);
  const cookieHeader = buildCookieHeader(url, cookies);
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...extraHeaders,
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    const rec: PhaseRecord = {
      phase,
      label,
      status: 'NETWORK_ERR',
      notes: (err as Error).message,
    };
    await appendRecord(rec);
    log(`phase ${phase}: ${label} → NETWORK_ERR (${rec.notes})`);
    return rec;
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const rec: PhaseRecord = {
      phase,
      label,
      status: res.status,
      notes: `non-JSON body (preview: ${text.slice(0, 120).replace(/\s+/g, ' ').trim()})`,
    };
    await appendRecord(rec);
    log(`phase ${phase}: ${label} → ${res.status} (non-JSON)`);
    return rec;
  }
  const env = parsed as {
    resultType?: string;
    success?: { email?: string; [k: string]: unknown };
    error?: { errorCode?: string };
  };
  if (env.resultType === 'SUCCESS' && env.success) {
    const userEmailHash = hashStringPrefix(env.success.email);
    const rec: PhaseRecord = {
      phase,
      label,
      status: res.status,
      successKeys: Object.keys(env.success).sort(),
      ...(userEmailHash !== undefined ? { userEmailHash } : {}),
    };
    await appendRecord(rec);
    log(`phase ${phase}: ${label} → ${res.status} (keys: ${rec.successKeys?.join(',')})`);
    return rec;
  }
  const errorCode = env.error?.errorCode;
  const rec: PhaseRecord = {
    phase,
    label,
    status: res.status,
    ...(errorCode !== undefined ? { errorCode } : {}),
    isAuthError: res.status === 401 || errorCode === '4010',
  };
  await appendRecord(rec);
  log(`phase ${phase}: ${label} → ${res.status} errorCode=${rec.errorCode}`);
  return rec;
}

async function captureError(
  phase: 'A' | 'B' | 'C' | 'D',
  label: string,
  err: unknown,
): Promise<PhaseRecord> {
  if (err instanceof TossApiError) {
    const rec: PhaseRecord = {
      phase,
      label,
      status: err.status,
      errorCode: err.errorCode,
      isAuthError: err.isAuthError,
    };
    await appendRecord(rec);
    log(`phase ${phase}: ${label} → ${err.status} errorCode=${err.errorCode}`);
    return rec;
  }
  const rec: PhaseRecord = {
    phase,
    label,
    status: 'NETWORK_ERR',
    notes: (err as Error).message,
  };
  await appendRecord(rec);
  log(`phase ${phase}: ${label} → ERROR (${rec.notes})`);
  return rec;
}

// ---- Helpers ----

// Minimal cookie-header builder, RFC-6265-ish. We could import cookieHeaderFor
// from src/api/http.ts, but doing the work here makes the spike a faithful
// replica of "what would a fresh script in CI write?".
function buildCookieHeader(url: URL, cookies: readonly CdpCookie[]): string | null {
  const host = url.hostname.toLowerCase();
  const matched = cookies.filter((c) => {
    const d = c.domain.toLowerCase();
    if (d === host) return true;
    if (d.startsWith('.') && host.endsWith(d)) return true;
    if (!d.startsWith('.') && host.endsWith(`.${d}`)) return true;
    return false;
  });
  if (matched.length === 0) return null;
  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

function encodeCookieBlobBase64(cookies: readonly CdpCookie[]): string {
  return Buffer.from(JSON.stringify(cookies)).toString('base64');
}

function encodeCookieBlobMinimal(cookies: readonly CdpCookie[]): string {
  // Just name=value pairs, joined by ';'. Loses domain/path/expires metadata
  // — we'll synthesize defaults on decode.
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function decodeCookieBlob(blob: string): CdpCookie[] {
  // Try base64 JSON first.
  if (/^[A-Za-z0-9+/=]+$/.test(blob.trim()) && blob.length > 100) {
    try {
      const json = Buffer.from(blob, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed as CdpCookie[];
    } catch {
      // fall through
    }
  }
  // Minimal name=value form. Synthesise the rest with values that the
  // builder accepts (domain `.toss.im`, path `/`, secure true).
  return blob
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): CdpCookie => {
      const eq = part.indexOf('=');
      if (eq < 0) throw new Error(`bad cookie pair: ${part.slice(0, 16)}…`);
      return {
        name: part.slice(0, eq),
        value: part.slice(eq + 1),
        domain: '.toss.im',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        session: false,
      };
    });
}

function hashStringPrefix(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // Just a stability marker — first 6 hex of FNV-1a so the report can show
  // "phase A and D returned the same user" without leaking the email.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

async function appendRecord(rec: PhaseRecord): Promise<void> {
  await writeFile(RESPONSES_PATH, `${JSON.stringify(rec)}\n`, { flag: 'a', mode: 0o600 });
}

async function writeCookieShape(cookies: readonly CdpCookie[]): Promise<void> {
  const shape = cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite ?? null,
  }));
  await writeFile(SHAPE_PATH, JSON.stringify(shape, null, 2), { mode: 0o600 });
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function summarise(records: readonly PhaseRecord[]): Promise<void> {
  log('');
  log('=== CI cookie spike result ===');
  for (const r of records) {
    const detail =
      r.status === 200 ? `user-hash=${r.userEmailHash ?? '?'}` : (r.errorCode ?? r.notes ?? '');
    log(`phase ${r.phase}: ${r.label.padEnd(60)} status=${r.status} ${detail}`);
  }
  log('');

  const verdict = decideVerdict(records);
  log(`verdict: ${verdict}`);
  log('');
  log(`raw responses:  ${RESPONSES_PATH}`);
  log(`cookie shape:   ${SHAPE_PATH}`);
}

function decideVerdict(records: readonly PhaseRecord[]): string {
  const a = records.find((r) => r.phase === 'A');
  if (!a || a.status !== 200) return 'BASELINE_FAILED — session is dead, re-run aitcc login';
  const allOk = records.every((r) => r.status === 200);
  if (allOk && process.env.AITCC_COOKIE_BLOB) return 'VIABLE (incl. env-blob path D)';
  if (allOk && !process.env.AITCC_COOKIE_BLOB) {
    return 'LOCAL_VIABLE (phases A–C + local round-trip ok; phase D from different IP not yet exercised)';
  }
  const cFails = records.filter((r) => r.phase === 'C' && r.status !== 200);
  if (cFails.length > 0 && cFails.every((r) => r.isAuthError)) {
    return 'UA_BOUND (cookies rejected when User-Agent changes)';
  }
  const dFails = records.filter((r) => r.phase === 'D' && r.status !== 200);
  if (dFails.length > 0 && process.env.AITCC_COOKIE_BLOB) {
    return 'IP_BOUND_OR_FINGERPRINT (env-blob from different host failed; check phase B/C status to disambiguate)';
  }
  return 'INCONCLUSIVE — see records';
}

main().catch((err) => {
  process.stderr.write(`spike crashed: ${(err as Error).message}\n`);
  process.exit(2);
});
