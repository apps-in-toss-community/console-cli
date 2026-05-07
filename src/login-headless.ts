// Headless form-fill login flow. Drives Chrome via CDP just like the
// interactive path, but injects credentials into the Toss Business
// sign-in form instead of waiting for a human to type them. If the form
// fill fails (selector mismatch, form not present, etc.) the caller is
// expected to fall back to the interactive path — this module never
// retries or loops on its own (rate-limit risk).
//
// Step-up auth (Toss app push, OTP, …) is detected by URL pattern OR by
// Korean text in the page body. When triggered we ask the user to
// complete the prompt in their Toss app and keep polling for the
// landing URL.
//
// SECURITY: the password value flows through Runtime.evaluate (over the
// CDP WebSocket on localhost) and never out of this process. We must
// not log it, embed it in error messages, or surface it via --json. The
// public errors below redact deliberately.

import {
  type CdpClient,
  evaluateInPage,
  getMainFrameUrl,
  setUserAgentOverride,
  watchMainFrameNavigations,
} from './cdp.js';
import { isLoginLanding } from './commands/login.js';

// Stock Chrome 130 UA on macOS — the auth spike confirmed servers stop
// flagging the request once the "HeadlessChrome" token is gone. We don't
// vary by platform: toss.im doesn't OS-fingerprint here, the only goal
// is to drop the headless token. Last verified against business.toss.im
// 2026-05-08; bump the version string when the next reviewer touches
// this file and Chrome stable has moved.
export const SPOOFED_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// URL fragments that indicate we've been bumped to a step-up challenge.
// Matched case-insensitively against the main-frame URL.
export const STEP_UP_URL_PATTERN = /verify|step.?up|2fa|otp/i;

// Korean copy that the console uses on step-up prompts. Spike never
// triggered the path, so these come from the patterns the Toss web team
// uses across other surfaces ("토스 앱에서 확인", "간편인증", "전자서명").
export const STEP_UP_BODY_PATTERN = /토스 ?앱|간편인증|전자서명|앱.{0,3}확인/;

// Match against pathname only, not the full URL. The OAuth sign-in URL
// embeds `redirect_uri=https%3A%2F%2Fapps-in-toss…` in its query string;
// the `%2F%2Fa` decodes-as-bytes to literally contain `2Fa`, which the
// `2fa` alternation otherwise matches and trips a false step-up on the
// very first poll.
export function urlIndicatesStepUp(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return STEP_UP_URL_PATTERN.test(pathname);
}

export function bodyIndicatesStepUp(bodyText: string): boolean {
  return STEP_UP_BODY_PATTERN.test(bodyText);
}

export interface HeadlessLoginCredentials {
  readonly email: string;
  readonly password: string;
}

// Wider than just success/failure so the caller knows whether to message
// the user about step-up or to silently fall back to interactive.
export type HeadlessLoginOutcome =
  | { readonly kind: 'ok'; readonly stepUp: boolean }
  | { readonly kind: 'fallback'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly stage: 'submit' | 'step-up' };

export interface RunHeadlessLoginOptions {
  readonly client: CdpClient;
  readonly sessionId: string;
  readonly credentials: HeadlessLoginCredentials;
  // Overall observation window after the form submit. The interactive
  // path's --timeout is much larger because a human types; here we only
  // need long enough for the OAuth chain (~1.3s observed) to finish, so
  // 30s is a comfortable default.
  readonly submitObservationMs?: number;
  // How long to wait for the user to complete a step-up prompt (Toss app
  // push, OTP, …). Defaults to the caller's overall --timeout so we
  // honour the user's intent.
  readonly stepUpTimeoutMs: number;
  // Hook so the CLI command can print a single "토스 앱에서 …" line on
  // stderr without this module taking a dependency on process.stderr.
  readonly onStepUp?: () => void;
}

const FORM_READY_POLL_MS = 500;
const FORM_READY_TIMEOUT_MS = 20_000;
const POST_SUBMIT_POLL_MS = 250;
const STEP_UP_POLL_MS = 1000;

// Form-fill JS, evaluated in the Toss Business sign-in page. Lives as a
// string so we don't have to worry about TypeScript transforms changing
// the shape — the eval target is the browser, not Node.
//
// React (Radix UI) treats inputs as controlled components: a plain
// `input.value = …` assignment is invisible to React state. We have to
// call the native value setter and dispatch an `input` event so React's
// onChange handler picks it up. The same trick worked in the spike.
//
// Selectors are intentionally robust to id changes (Radix ids look like
// `radix-:r0:` and aren't stable):
//   - email input matched by name (`email`/`loginId`/`username`),
//     then by type (`email`/`text`).
//   - password input matched by name then by `type=password`.
//   - submit button matched by `type=submit` first, then by visible text
//     containing "로그인" / "sign in" / "login".
const FILL_AND_SUBMIT_FN = `
  async (email, password) => {
    function pickByName(names) {
      for (const n of names) {
        const el = document.querySelector('input[name="' + n + '"]');
        if (el) return el;
      }
      return null;
    }
    function pickInputByType(types) {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const t of types) {
        const hit = inputs.find(i => (i.type || '').toLowerCase() === t);
        if (hit) return hit;
      }
      return null;
    }
    function setNative(input, value) {
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const emailInput =
      pickByName(['email', 'loginId', 'username']) ||
      pickInputByType(['email', 'text']);
    const passwordInput =
      pickByName(['password', 'loginPassword']) ||
      pickInputByType(['password']);
    if (!emailInput) return { ok: false, stage: 'find-email' };
    if (!passwordInput) return { ok: false, stage: 'find-password' };
    setNative(emailInput, email);
    setNative(passwordInput, password);
    const buttons = Array.from(document.querySelectorAll('button'));
    const submitBtn = buttons.find(b => {
      if (b.disabled) return false;
      const t = (b.type || '').toLowerCase();
      if (t === 'submit') return true;
      const txt = (b.textContent || '').replace(/\\s+/g, '');
      return /로그인|sign-?in|login/i.test(txt);
    });
    if (submitBtn) {
      submitBtn.click();
      return { ok: true, stage: 'submit-button' };
    }
    const form = emailInput.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { ok: true, stage: 'submit-form' };
    }
    return { ok: false, stage: 'submit' };
  }
`;

// Probe the page to see whether the email + password inputs have
// rendered. The form arrives async (React boot), so we have to poll
// before we can fill.
const FORM_READY_PROBE_FN = `
  () => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const hasEmail = inputs.some(i => {
      const name = (i.name || '').toLowerCase();
      const type = (i.type || '').toLowerCase();
      const placeholder = (i.placeholder || '').toLowerCase();
      const id = (i.id || '').toLowerCase();
      if (name === 'email' || name === 'loginid' || name === 'username') return true;
      if (type === 'email') return true;
      if (type === 'text' && /id|email|username/.test(name + ' ' + id + ' ' + placeholder)) return true;
      return false;
    });
    const hasPassword = inputs.some(i =>
      (i.type || '').toLowerCase() === 'password' || (i.name || '').toLowerCase() === 'password',
    );
    return { ready: hasEmail && hasPassword, count: inputs.length };
  }
`;

// Snapshot of post-submit state used to decide between landing /
// step-up / fallback. Body text capped at 4 KB so we don't pull
// arbitrarily-large pages over the CDP wire.
const POST_SUBMIT_PROBE_FN = `
  () => {
    const bodyText = (document.body && document.body.innerText || '').slice(0, 4000);
    const hasCaptchaIframe = !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="cloudflare"]'
    );
    const hasErrorBanner = /비밀번호.{0,10}(틀|일치)|아이디.{0,10}(틀|일치)|로그인.{0,5}(실패|불가)|차단|locked/i.test(bodyText);
    return { url: location.href, bodyText, hasCaptchaIframe, hasErrorBanner };
  }
`;

interface FormReadyProbe {
  ready: boolean;
  count: number;
}

interface FillResult {
  ok: boolean;
  stage: string;
}

interface PostSubmitProbe {
  url: string;
  bodyText: string;
  hasCaptchaIframe: boolean;
  hasErrorBanner: boolean;
}

/**
 * Drive the sign-in form and return when we either landed on the
 * console workspace, hit a step-up prompt that the user resolved, or
 * decided the headless path can't make progress. This function never
 * touches the cookie store or session file — that stays in the calling
 * command after we return `'ok'`.
 *
 * Errors that should fall back to interactive (form not found, captcha,
 * eval failure) are returned as `{ kind: 'fallback', reason }` rather
 * than thrown. Real I/O errors (CDP socket dies) propagate.
 */
export async function runHeadlessLogin(
  options: RunHeadlessLoginOptions,
): Promise<HeadlessLoginOutcome> {
  const {
    client,
    sessionId,
    credentials,
    submitObservationMs = 30_000,
    stepUpTimeoutMs,
    onStepUp,
  } = options;

  // Set the UA before we let the page do any more network. Network/Runtime
  // need explicit enable; Page is enabled lazily by `watchMainFrameNavigations`
  // before we start polling.
  await client.send('Network.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await setUserAgentOverride(client, sessionId, SPOOFED_USER_AGENT);

  // The page may have started loading with the original headless UA before
  // we got to override it. Reload so the request actually carries our
  // spoofed header.
  await client.send('Page.reload', { ignoreCache: true }, sessionId).catch(() => {
    // best-effort: if reload fails (e.g. about:blank), the next nav still
    // picks up the override.
  });

  const ready = await waitForFormReady(client, sessionId);
  if (!ready.ok) {
    return { kind: 'fallback', reason: ready.reason };
  }

  const fill = await evaluateInPage<FillResult>(
    client,
    sessionId,
    `(${FILL_AND_SUBMIT_FN})(${JSON.stringify(credentials.email)}, ${JSON.stringify(credentials.password)})`,
  );
  if (!fill.ok) {
    // Don't surface the eval error message verbatim — a future Chrome
    // could echo the original expression and leak the password. The
    // Runtime.evaluate path doesn't actually do that today, but the
    // redaction is cheap insurance.
    return { kind: 'fallback', reason: 'form-fill-eval-failed' };
  }
  if (!fill.value.ok) {
    return { kind: 'fallback', reason: `form-fill-${fill.value.stage}` };
  }

  // Watch live navigations so we react to the OAuth-redirect chain in
  // ~ms rather than ~1s polls. Polling is still the primary signal.
  let liveLandingUrl: string | null = null;
  const offNav = await watchMainFrameNavigations(client, sessionId, (ev) => {
    if (!ev.isMainFrame) return;
    if (isLoginLanding(ev.url)) liveLandingUrl = ev.url;
  });

  try {
    // Phase 1: poll for either landing or step-up over `submitObservationMs`.
    const phase1 = await observeUntilLandingOrStepUp(
      client,
      sessionId,
      submitObservationMs,
      () => liveLandingUrl,
    );

    if (phase1.kind === 'landed') {
      return { kind: 'ok', stepUp: false };
    }
    if (phase1.kind === 'fallback') {
      return { kind: 'fallback', reason: phase1.reason };
    }
    if (phase1.kind === 'timeout') {
      return { kind: 'timeout', stage: 'submit' };
    }

    // Phase 2: step-up. Inform the caller and wait — much longer — for
    // the user to complete the Toss-app prompt.
    onStepUp?.();
    const phase2 = await pollForLanding(client, sessionId, stepUpTimeoutMs, () => liveLandingUrl);
    if (phase2 === 'landed') return { kind: 'ok', stepUp: true };
    // `pollForLanding` is typed `'landed' | 'timeout'`; the assignment below
    // is a compile-time exhaustiveness check that catches a future return
    // value being added without the matching case here.
    const _: 'timeout' = phase2;
    void _;
    return { kind: 'timeout', stage: 'step-up' };
  } finally {
    offNav();
  }
}

interface FormReadyOk {
  readonly ok: true;
}
interface FormReadyFail {
  readonly ok: false;
  readonly reason: string;
}

async function waitForFormReady(
  client: CdpClient,
  sessionId: string,
): Promise<FormReadyOk | FormReadyFail> {
  const deadline = Date.now() + FORM_READY_TIMEOUT_MS;
  let lastReason = 'timeout';
  while (Date.now() < deadline) {
    const probe = await evaluateInPage<FormReadyProbe>(
      client,
      sessionId,
      `(${FORM_READY_PROBE_FN})()`,
    );
    if (probe.ok) {
      if (probe.value.ready) return { ok: true };
      lastReason = `inputs-not-ready (${probe.value.count} input(s) on page)`;
    } else {
      // The page may still be loading and Runtime.evaluate may transiently
      // fail (`Execution context was destroyed`); keep retrying. Don't fold
      // `probe.error` into the reason — same redaction discipline as the
      // form-fill eval path: today's CDP error text is benign, but a future
      // Chrome could echo the original expression in the message.
      lastReason = 'eval-failed';
    }
    await sleep(FORM_READY_POLL_MS);
  }
  return { ok: false, reason: `form-not-ready: ${lastReason}` };
}

type Phase1Result =
  | { kind: 'landed' }
  | { kind: 'step-up' }
  | { kind: 'fallback'; reason: string }
  | { kind: 'timeout' };

async function observeUntilLandingOrStepUp(
  client: CdpClient,
  sessionId: string,
  totalMs: number,
  liveLanding: () => string | null,
): Promise<Phase1Result> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (liveLanding()) return { kind: 'landed' };
    const fromTree = await getMainFrameUrl(client, sessionId);
    if (fromTree && isLoginLanding(fromTree)) return { kind: 'landed' };

    const probe = await evaluateInPage<PostSubmitProbe>(
      client,
      sessionId,
      `(${POST_SUBMIT_PROBE_FN})()`,
    );
    if (probe.ok) {
      if (isLoginLanding(probe.value.url)) return { kind: 'landed' };
      if (probe.value.hasCaptchaIframe) {
        return { kind: 'fallback', reason: 'captcha-detected' };
      }
      if (probe.value.hasErrorBanner) {
        // Could be a wrong-password case — let the user retype manually
        // rather than silently re-trying with the same credentials and
        // tripping a rate-limit lockout.
        return { kind: 'fallback', reason: 'login-error-banner' };
      }
      if (urlIndicatesStepUp(probe.value.url) || bodyIndicatesStepUp(probe.value.bodyText)) {
        return { kind: 'step-up' };
      }
    }
    await sleep(POST_SUBMIT_POLL_MS);
  }
  return { kind: 'timeout' };
}

async function pollForLanding(
  client: CdpClient,
  sessionId: string,
  totalMs: number,
  liveLanding: () => string | null,
): Promise<'landed' | 'timeout'> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (liveLanding()) return 'landed';
    const url = await getMainFrameUrl(client, sessionId);
    if (url && isLoginLanding(url)) return 'landed';
    await sleep(STEP_UP_POLL_MS);
  }
  return 'timeout';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// Exported for unit tests. The real flow takes a CdpClient; tests can
// drive the matchers directly without standing up a fake socket.
export const __test = {
  FILL_AND_SUBMIT_FN,
  FORM_READY_PROBE_FN,
  POST_SUBMIT_PROBE_FN,
};
