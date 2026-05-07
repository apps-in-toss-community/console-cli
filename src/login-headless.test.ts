import { describe, expect, it } from 'vitest';
import { isLoginLanding } from './commands/login.js';
import {
  __test,
  bodyIndicatesStepUp,
  SPOOFED_USER_AGENT,
  STEP_UP_BODY_PATTERN,
  STEP_UP_URL_PATTERN,
  urlIndicatesStepUp,
} from './login-headless.js';

// The headless flow's CDP I/O is e2e-only, but the matchers that decide
// "did we land?", "is this a step-up screen?", and "should we fall back?"
// are pure-data and must keep working as the form / URL chain evolves.

describe('SPOOFED_USER_AGENT', () => {
  it('does NOT contain the HeadlessChrome token (the whole point)', () => {
    expect(SPOOFED_USER_AGENT.toLowerCase()).not.toContain('headless');
  });

  it('looks like a recent stable Chrome UA', () => {
    expect(SPOOFED_USER_AGENT).toMatch(/Chrome\/\d+\.\d+\.\d+\.\d+/);
    expect(SPOOFED_USER_AGENT).toMatch(/Safari\/537\.36/);
  });
});

describe('urlIndicatesStepUp', () => {
  // Spike never observed step-up in the wild, so these cover the
  // patterns the existing Toss surfaces use elsewhere — code below has
  // to treat them as step-up if/when toss.im starts emitting them on
  // sign-in.
  it('matches /verify path', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/verify')).toBe(true);
  });
  it('matches step-up with hyphen', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/auth/step-up?ctx=abc')).toBe(true);
  });
  it('matches step_up with underscore', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/auth/step_up')).toBe(true);
  });
  it('matches stepup with no separator', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/auth/stepup')).toBe(true);
  });
  it('matches /2fa', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/2fa')).toBe(true);
  });
  it('matches /otp', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/otp/issue')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/VERIFY')).toBe(true);
    expect(urlIndicatesStepUp('https://business.toss.im/Step-Up')).toBe(true);
  });
  it('does NOT match the workspace landing URL', () => {
    expect(urlIndicatesStepUp('https://apps-in-toss.toss.im/workspace')).toBe(false);
  });
  it('does NOT match the sign-in URL', () => {
    expect(urlIndicatesStepUp('https://business.toss.im/account/sign-in?client_id=abc')).toBe(
      false,
    );
  });
});

describe('bodyIndicatesStepUp', () => {
  it('matches "토스 앱" copy', () => {
    expect(bodyIndicatesStepUp('토스 앱에서 인증을 완료해주세요')).toBe(true);
  });
  it('matches "토스앱" with no space', () => {
    expect(bodyIndicatesStepUp('토스앱으로 알림을 보냈습니다')).toBe(true);
  });
  it('matches "간편인증"', () => {
    expect(bodyIndicatesStepUp('간편인증으로 로그인합니다')).toBe(true);
  });
  it('matches "전자서명"', () => {
    expect(bodyIndicatesStepUp('전자서명을 진행해 주세요')).toBe(true);
  });
  it('matches "앱…확인" variants within the regex window', () => {
    expect(bodyIndicatesStepUp('앱에서 확인해주세요')).toBe(true);
    // The regex allows up to 3 chars between 앱 and 확인 to keep matches
    // tight; longer interleaving falls through. That's by design — copy
    // farther apart than "앱에서" usually isn't a step-up prompt.
    expect(bodyIndicatesStepUp('앱확인')).toBe(true);
  });
  it('does NOT match generic sign-in copy', () => {
    expect(bodyIndicatesStepUp('아이디와 비밀번호를 입력하세요')).toBe(false);
    expect(bodyIndicatesStepUp('로그인 상태를 유지합니다')).toBe(false);
  });
  it('does NOT match an empty body', () => {
    expect(bodyIndicatesStepUp('')).toBe(false);
  });
});

describe('step-up patterns are anchored to expectations', () => {
  // These are loadbearing — if someone tightens the regex they should
  // see the assertion that the spike-supplied vocabulary still matches.
  it('URL pattern keeps the four observed tokens', () => {
    const src = STEP_UP_URL_PATTERN.source.toLowerCase();
    for (const token of ['verify', 'step', '2fa', 'otp']) {
      expect(src).toContain(token);
    }
  });
  it('body pattern keeps the four observed Korean phrases', () => {
    const src = STEP_UP_BODY_PATTERN.source;
    expect(src).toContain('토스');
    expect(src).toContain('간편인증');
    expect(src).toContain('전자서명');
    expect(src).toContain('앱');
  });
});

describe('isLoginLanding interplay (sanity)', () => {
  // Reaffirm the rule that drives the headless poll loop's success
  // signal — it has to keep matching the workspace URL, and
  // `urlIndicatesStepUp` must not double-match landing URLs. Otherwise
  // the headless flow would settle as `step-up` instead of `ok`.
  it('landing URL is recognised as a landing', () => {
    expect(
      isLoginLanding('https://apps-in-toss.toss.im/workspace?code=abc&state=%2Fworkspace'),
    ).toBe(true);
  });
  it('landing URL is NOT mis-classified as step-up', () => {
    expect(urlIndicatesStepUp('https://apps-in-toss.toss.im/workspace?code=abc')).toBe(false);
  });
});

describe('FILL_AND_SUBMIT_FN is robust to selector drift', () => {
  // The browser-side JS lives as a string template; confirm the spike's
  // observed selectors are still in the source so a future cleanup
  // can't accidentally drop the radix-id fallback.
  it('queries by name first', () => {
    expect(__test.FILL_AND_SUBMIT_FN).toContain('email');
    expect(__test.FILL_AND_SUBMIT_FN).toContain('loginId');
    expect(__test.FILL_AND_SUBMIT_FN).toContain('username');
    expect(__test.FILL_AND_SUBMIT_FN).toContain('password');
  });
  it('falls back to type-based picking', () => {
    expect(__test.FILL_AND_SUBMIT_FN).toContain("'email'");
    expect(__test.FILL_AND_SUBMIT_FN).toContain("'text'");
    expect(__test.FILL_AND_SUBMIT_FN).toContain("'password'");
  });
  it('uses the native value setter (React controlled-component fix)', () => {
    expect(__test.FILL_AND_SUBMIT_FN).toContain('getOwnPropertyDescriptor');
    expect(__test.FILL_AND_SUBMIT_FN).toContain('desc.set.call');
  });
  it('dispatches both input and change events', () => {
    expect(__test.FILL_AND_SUBMIT_FN).toContain("'input'");
    expect(__test.FILL_AND_SUBMIT_FN).toContain("'change'");
  });
  it('falls back to button text when type=submit is not set', () => {
    expect(__test.FILL_AND_SUBMIT_FN).toContain('로그인');
    expect(__test.FILL_AND_SUBMIT_FN).toContain('sign-?in');
  });
});
