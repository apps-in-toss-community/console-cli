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
// the raw characters `%2F%2Fa` contain the literal substring `2fa`
// (case-insensitive), which the `2fa` alternation matches and trips a
// false step-up on the very first poll.
export function urlIndicatesStepUp(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return STEP_UP_URL_PATTERN.test(pathname);
}

// Detect the Toss 90-day password-rotation interstitial. Toss interposes
// this page between a successful sign-in and the OAuth redirect once 90 days
// have elapsed since the last password change. The page offers two buttons:
//   • "2차인증하고 변경하기" — triggers a 2FA + password change. NEVER click.
//   • "90일 뒤에 변경" — pure dismiss, resumes the OAuth chain. Safe to automate.
//
// Detection is pathname-only (same discipline as `urlIndicatesStepUp`) so
// the `redirect_uri` query string can't produce a false positive even if it
// contains the path fragment as an encoded substring.
export function isPasswordRotationInterstitial(url: string): boolean {
  let parsed: { host: string; pathname: string };
  try {
    const u = new URL(url);
    parsed = { host: u.host, pathname: u.pathname };
  } catch {
    return false;
  }
  return (
    parsed.host === 'business.toss.im' &&
    parsed.pathname.toLowerCase().includes('/change-password-for-security')
  );
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
  | { readonly kind: 'timeout'; readonly stage: 'submit' | 'step-up'; readonly observedMs: number };

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
// `radix-:r0:` and aren't stable) and to attribute renames. The Toss
// Business sign-in page (as of 2026-05) renders Radix UI inputs with no
// `name` attribute and email as `type="text"` (Korean IDs are also
// allowed), so neither `name`-based nor `type=email` selectors hit. To
// avoid filling credentials into an unrelated text input (e.g. a search
// box) we anchor the email lookup to the password input's containing
// `<form>`: the first text/email input above the password input inside
// the same form is the username field by construction.
//
// Lookup order (each falls back to the next):
//   1. `name` attribute (`email`/`loginId`/`username` or `password`).
//   2. `type` (`email` for email; `password` for password).
//   3. `aria-label`/`placeholder` containing "이메일" / "ID" / "Email" /
//      "비밀번호" / "password" — accessible labels the page exposes to
//      assistive tech, stable across Radix id reshuffles.
//   4. (email only) text input that appears before the password input
//      inside the same form. Anchoring on the password input means a
//      stray search box outside the form can't capture the email.
//
// Submit button matched by `type=submit` first, then by visible text
// containing "로그인" / "sign in" / "login".
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
    function pickByAccessibleLabel(textInputOnly, patterns) {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.find(i => {
        const type = (i.type || '').toLowerCase();
        if (textInputOnly && type !== 'text' && type !== 'email') return false;
        if (!textInputOnly && type !== 'password') return false;
        const label = (i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '');
        return patterns.some(p => p.test(label));
      }) || null;
    }
    function pickEmailFromPasswordForm(passwordInput) {
      const form = passwordInput && passwordInput.closest('form');
      if (!form) return null;
      const inputs = Array.from(form.querySelectorAll('input'));
      const passwordIdx = inputs.indexOf(passwordInput);
      if (passwordIdx < 0) return null;
      for (let i = 0; i < passwordIdx; i++) {
        const el = inputs[i];
        const type = (el.type || '').toLowerCase();
        if (type === 'text' || type === 'email') return el;
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
    const passwordInput =
      pickByName(['password', 'loginPassword']) ||
      pickInputByType(['password']) ||
      pickByAccessibleLabel(false, [/비밀번호/, /password/i]);
    const emailInput =
      pickByName(['email', 'loginId', 'username']) ||
      pickInputByType(['email']) ||
      pickByAccessibleLabel(true, [/이메일/, /\\bID\\b/, /email/i, /로그인.{0,5}(아이디|ID)/i]) ||
      pickEmailFromPasswordForm(passwordInput);
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
// before we can fill. Heuristics mirror FILL_AND_SUBMIT_FN so we don't
// signal "ready" when the picker would actually fail.
const FORM_READY_PROBE_FN = `
  () => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const hasEmail = inputs.some(i => {
      const name = (i.name || '').toLowerCase();
      const type = (i.type || '').toLowerCase();
      const placeholder = (i.placeholder || '').toLowerCase();
      const id = (i.id || '').toLowerCase();
      const aria = (i.getAttribute('aria-label') || '').toLowerCase();
      if (name === 'email' || name === 'loginid' || name === 'username') return true;
      if (type === 'email') return true;
      if (type === 'text') {
        const blob = name + ' ' + id + ' ' + placeholder + ' ' + aria;
        if (/id|email|username|이메일|아이디/.test(blob)) return true;
      }
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

// Defer-click JS for the 90-day password-rotation interstitial. Evaluated
// in the page after we detect the interstitial URL; clicks the dismiss
// button ("90일 뒤에 변경") and NEVER the danger button ("2차인증하고 변경하기").
//
// Selection order:
//   1. Enumerate all button / [role="button"] elements.
//   2. Pick candidates whose normalised text contains "90일" OR "뒤에 변경"
//      AND does NOT contain "2차인증" or "인증하고변경" (negated guard against
//      the danger button — structurally incapable of clicking it).
//   3. Cross-check: prefer elements with data-tds-desktop-button-variant="clear"
//      over other matches (the safe button carries that attribute).
//   4. If NO candidates remain (only danger matches, or nothing found),
//      return { ok: false, reason: 'only-danger-button' | 'defer-not-found' }.
//
// SAFETY: steps 2 is a HARD GUARD. The danger button text contains
// "2차인증하고변경하기" — the negation in step 2 structurally prevents it from
// ever being selected. This is not a best-effort hint; it is the load-bearing
// safety constraint.
const CLICK_DEFER_FN = `
  () => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const isDanger = (el) => {
      const txt = (el.textContent || '').replace(/\\s+/g, '');
      return /2차인증|인증하고변경/.test(txt);
    };
    const isDefer = (el) => {
      const txt = (el.textContent || '').replace(/\\s+/g, '');
      return (txt.includes('90일') || txt.includes('뒤에변경')) && !isDanger(el);
    };
    const dangerCount = candidates.filter(isDanger).length;
    const deferCandidates = candidates.filter(isDefer);
    if (deferCandidates.length === 0) {
      const reason = dangerCount > 0 ? 'only-danger-button' : 'defer-not-found';
      return { ok: false, reason };
    }
    // Prefer the clear/grey variant button (the safe dismiss button) over others.
    const preferred = deferCandidates.find(
      el => el.getAttribute('data-tds-desktop-button-variant') === 'clear',
    ) || deferCandidates[0];
    if (preferred.disabled) {
      return { ok: false, reason: 'defer-disabled' };
    }
    const clickedText = (preferred.textContent || '').trim();
    preferred.click();
    return { ok: true, clickedText };
  }
`;

// How long to wait for the SPA to render the defer button after the
// interstitial URL is first detected. The React root may not have booted yet.
const DEFER_BUTTON_WAIT_MS = 8_000;
const DEFER_BUTTON_POLL_MS = 200;

// Nag copy that should be present once the interstitial has fully rendered.
// We check for it before clicking so we don't click into a half-loaded page.
const PASSWORD_NAG_COPY_RE = /비밀번호를 변경한지|계정 보호|새 비밀번호/;

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

interface DeferClickResult {
  ok: boolean;
  reason?: string;
  clickedText?: string;
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
      return { kind: 'timeout', stage: 'submit', observedMs: phase1.observedMs };
    }

    // Phase 2: step-up. Inform the caller and wait — much longer — for
    // the user to complete the Toss-app prompt.
    onStepUp?.();
    const stepUpStart = Date.now();
    const phase2 = await pollForLanding(client, sessionId, stepUpTimeoutMs, () => liveLandingUrl);
    if (phase2 === 'landed') return { kind: 'ok', stepUp: true };
    // `pollForLanding` is typed `'landed' | 'timeout'`; the assignment below
    // is a compile-time exhaustiveness check that catches a future return
    // value being added without the matching case here.
    const _: 'timeout' = phase2;
    void _;
    return { kind: 'timeout', stage: 'step-up', observedMs: Date.now() - stepUpStart };
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
  | { kind: 'timeout'; observedMs: number };

async function observeUntilLandingOrStepUp(
  client: CdpClient,
  sessionId: string,
  totalMs: number,
  liveLanding: () => string | null,
): Promise<Phase1Result> {
  const start = Date.now();
  const deadline = start + totalMs;
  // Guard: click the defer button at most once per run to prevent a
  // render-race from triggering multiple clicks.
  let deferAttempted = false;

  while (Date.now() < deadline) {
    if (liveLanding()) return { kind: 'landed' };
    const fromTree = await getMainFrameUrl(client, sessionId);
    if (fromTree && isLoginLanding(fromTree)) return { kind: 'landed' };

    // Detect the 90-day password-rotation interstitial by URL. When found,
    // wait for the SPA to render the body copy + buttons, then click defer.
    // The final /workspace hop is a client-side SPA route with no
    // Page.frameNavigated event, so we MUST keep polling `getMainFrameUrl`
    // after clicking — the existing loop handles that.
    if (!deferAttempted && fromTree && isPasswordRotationInterstitial(fromTree)) {
      deferAttempted = true;
      const clickResult = await waitAndClickDefer(client, sessionId);
      if (clickResult.ok) {
        // Defer was clicked; continue polling for the final /workspace landing.
        await sleep(POST_SUBMIT_POLL_MS);
        continue;
      }
      // Defer click failed (only danger button visible, or not found).
      return { kind: 'fallback', reason: 'password-change-required' };
    }

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
      // Also detect the interstitial via the probe URL if getMainFrameUrl
      // returned null on that tick (race with the navigation committing).
      if (!deferAttempted && isPasswordRotationInterstitial(probe.value.url)) {
        deferAttempted = true;
        const clickResult = await waitAndClickDefer(client, sessionId);
        if (clickResult.ok) {
          await sleep(POST_SUBMIT_POLL_MS);
          continue;
        }
        return { kind: 'fallback', reason: 'password-change-required' };
      }
      if (urlIndicatesStepUp(probe.value.url) || bodyIndicatesStepUp(probe.value.bodyText)) {
        return { kind: 'step-up' };
      }
    }
    await sleep(POST_SUBMIT_POLL_MS);
  }
  return { kind: 'timeout', observedMs: Date.now() - start };
}

/**
 * Wait up to DEFER_BUTTON_WAIT_MS for the SPA to render the interstitial's
 * body copy and buttons, then run the defer-click eval. Returns the result
 * of the eval (ok/not-ok) so the caller can decide whether to fall back.
 */
async function waitAndClickDefer(client: CdpClient, sessionId: string): Promise<DeferClickResult> {
  const deadline = Date.now() + DEFER_BUTTON_WAIT_MS;
  while (Date.now() < deadline) {
    const probe = await evaluateInPage<PostSubmitProbe>(
      client,
      sessionId,
      `(${POST_SUBMIT_PROBE_FN})()`,
    );
    if (probe.ok) {
      const hasNagCopy = PASSWORD_NAG_COPY_RE.test(probe.value.bodyText);
      const hasButtons = probe.value.bodyText.length > 0;
      if (hasNagCopy && hasButtons) {
        // Page appears ready; run the defer click.
        const click = await evaluateInPage<DeferClickResult>(
          client,
          sessionId,
          `(${CLICK_DEFER_FN})()`,
        );
        if (click.ok) return click.value;
        // eval itself failed (e.g. context destroyed mid-nav) — treat
        // as not-found rather than leaking the eval error.
        return { ok: false, reason: 'defer-eval-failed' };
      }
    }
    await sleep(DEFER_BUTTON_POLL_MS);
  }
  // Timed out waiting for the interstitial body to render.
  return { ok: false, reason: 'defer-not-found' };
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
  CLICK_DEFER_FN,
};
