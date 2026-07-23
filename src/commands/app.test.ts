import { describe, expect, it } from 'vitest';
import {
  augmentCertExpiry,
  deriveDaysUntilExpiry,
  deriveLsStatus,
  deriveReviewState,
  findReviewEntry,
  pickCertById,
  pickMiniAppView,
  reviewStateFor,
  reviewStateInputFrom,
  serviceStatusFor,
} from './app.js';

// parseNonNegativeInt is not exported (rendering would widen the surface
// without enough reuse) — ratings parsing is covered at the CLI level via
// integration tests in env where the CLI spawns.

// `app ls` joins two endpoints (`mini-app` list + `mini-apps/review-status`)
// by best-effort id match. The helpers are pure and the three-key fallback
// logic is exactly the place a silent "simplify" refactor would regress.

describe('findReviewEntry', () => {
  it('matches by `id` (string)', () => {
    const entries = [{ id: 'abc', reviewState: 'APPROVED' }];
    expect(findReviewEntry(entries, 'abc')).toBe(entries[0]);
  });

  it('matches by `miniAppId` (number, with string target via coercion)', () => {
    const entries = [{ miniAppId: 999, reviewState: 'PENDING' }];
    expect(findReviewEntry(entries, '999')).toBe(entries[0]);
  });

  it('matches by `appId` fallback', () => {
    const entries = [{ appId: 42, reviewState: 'REJECTED' }];
    expect(findReviewEntry(entries, 42)).toBe(entries[0]);
  });

  it('prefers `id` over `miniAppId` when both are present', () => {
    const entries = [{ id: 'primary', miniAppId: 'secondary' }];
    expect(findReviewEntry(entries, 'primary')).toBe(entries[0]);
    expect(findReviewEntry(entries, 'secondary')).toBeNull();
  });

  it('returns null on miss', () => {
    const entries = [{ id: 'abc' }, { miniAppId: 'def' }];
    expect(findReviewEntry(entries, 'ghi')).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(findReviewEntry([], 'abc')).toBeNull();
  });
});

describe('reviewStateFor', () => {
  it('returns undefined on null entry', () => {
    expect(reviewStateFor(null)).toBeUndefined();
  });

  it('reads `reviewState` when present', () => {
    expect(reviewStateFor({ reviewState: 'APPROVED' })).toBe('APPROVED');
  });

  it('falls back to `status`', () => {
    expect(reviewStateFor({ status: 'PENDING' })).toBe('PENDING');
  });

  it('prefers `reviewState` over `status` when both are present', () => {
    expect(reviewStateFor({ reviewState: 'APPROVED', status: 'PENDING' })).toBe('APPROVED');
  });

  it('returns undefined when the field is not a string', () => {
    expect(reviewStateFor({ reviewState: 123 })).toBeUndefined();
    expect(reviewStateFor({})).toBeUndefined();
  });
});

// `pickMiniAppView` decides what `aitcc app show --view <x>` renders. Up
// through 0.1.45 this picked between two independently-fetched `current`/
// `draft` payloads off the `/with-draft` envelope. That endpoint 404s as of
// issue #219 (upstream path drift) — its replacement (`fetchMiniAppDetail`)
// returns a single mini-app record plus an envelope-level `hasApproved`
// flag, so there's no separate draft/current payload to pick between
// anymore. `draft`/`merged` both resolve to the one available record;
// `current` reuses `hasApproved` to preserve the old "empty until first
// approval" contract (so agent-plugin can still tell "not reviewed" apart
// from "reviewed and published" via `view`).
describe('pickMiniAppView', () => {
  const miniApp = { title: 'the record', description: 'd' };

  it('draft (default) returns the record regardless of approval state', () => {
    expect(pickMiniAppView({ miniApp, hasApproved: false }, 'draft')).toEqual(miniApp);
    expect(pickMiniAppView({ miniApp, hasApproved: true }, 'draft')).toEqual(miniApp);
  });

  it('current returns the record when hasApproved is true', () => {
    expect(pickMiniAppView({ miniApp, hasApproved: true }, 'current')).toEqual(miniApp);
  });

  it('current returns null when hasApproved is false (not reviewed yet)', () => {
    // Explicit: asking for `current` on an unreviewed app returns null (not
    // the record) so agent-plugin can distinguish "not reviewed" from
    // "reviewed and published".
    expect(pickMiniAppView({ miniApp, hasApproved: false }, 'current')).toBeNull();
  });

  it('draft view when miniApp itself is null returns null', () => {
    expect(pickMiniAppView({ miniApp: null, hasApproved: false }, 'draft')).toBeNull();
  });

  it('merged returns the record regardless of approval state (only one snapshot exists)', () => {
    expect(pickMiniAppView({ miniApp, hasApproved: true }, 'merged')).toEqual(miniApp);
    expect(pickMiniAppView({ miniApp, hasApproved: false }, 'merged')).toEqual(miniApp);
  });
});

// deriveReviewState encodes the UI "검토 중" banner rule so `app status`
// has a single place to evolve when the rejected / approved shapes come in
// from a real review cycle. Documented combinations live in app.ts above
// the function; these tests pin each one.
//
// Up through 0.1.45 this took `{current, draft}` nullable records straight
// off the `/with-draft` envelope. That endpoint 404s as of issue #219; its
// replacement (`fetchMiniAppDetail`) already exposes `hasApproved`/`hasDraft`
// as booleans, so the function (and these tests) now take `hasCurrent`/
// `hasDraft` directly instead of re-deriving them from `!== null` checks.
// The state-machine logic under test is otherwise unchanged.
describe('deriveReviewState', () => {
  const base = { hasCurrent: false, hasDraft: true, approvalType: null, rejectedMessage: null };

  it('not-submitted when approvalType is null', () => {
    expect(deriveReviewState({ ...base }).state).toBe('not-submitted');
  });

  it('under-review when approvalType=REVIEW and hasCurrent is false', () => {
    expect(deriveReviewState({ ...base, approvalType: 'REVIEW', hasCurrent: false }).state).toBe(
      'under-review',
    );
  });

  it('rejected when rejectedMessage is a non-null string', () => {
    const s = deriveReviewState({
      ...base,
      approvalType: 'REVIEW',
      hasCurrent: false,
      rejectedMessage: 'violates policy X',
    });
    expect(s.state).toBe('rejected');
    expect(s.rejectedMessage).toBe('violates policy X');
  });

  it('approved when hasCurrent is true and there is no fresh draft', () => {
    expect(
      deriveReviewState({
        hasCurrent: true,
        hasDraft: false,
        approvalType: 'REVIEW',
        rejectedMessage: null,
      }).state,
    ).toBe('approved');
  });

  it('approved-with-edits when both hasCurrent and hasDraft are true', () => {
    expect(
      deriveReviewState({
        hasCurrent: true,
        hasDraft: true,
        approvalType: 'REVIEW',
        rejectedMessage: null,
      }).state,
    ).toBe('approved-with-edits');
  });

  it('unknown for approvalType values other than REVIEW (forward-compat)', () => {
    // A future approvalType we haven't observed shouldn't get silently mapped
    // to under-review — flag it as unknown so we notice and add a branch.
    expect(
      deriveReviewState({
        ...base,
        approvalType: 'FUTURE_TYPE',
        hasCurrent: false,
      }).state,
    ).toBe('unknown');
  });

  it('reports hasCurrent/hasDraft flags truthfully so JSON consumers have the raw signal too', () => {
    const s = deriveReviewState({
      hasCurrent: true,
      hasDraft: true,
      approvalType: 'REVIEW',
      rejectedMessage: null,
    });
    expect(s.hasCurrent).toBe(true);
    expect(s.hasDraft).toBe(true);
  });

  // `locked` reflects the authoritative update-lock signal. The derived `state`
  // ladder isn't a reliable proxy: a `approved-with-edits` app can still be
  // locked (4046) because review is queued for the in-flight draft. Single
  // source of truth is `approvalType === 'REVIEW'`.
  it('locked when approvalType is REVIEW (under-review case)', () => {
    const s = deriveReviewState({
      ...base,
      approvalType: 'REVIEW',
      hasCurrent: false,
    });
    expect(s.locked).toBe(true);
    expect(s.lockReason).toBe('review-pending');
  });

  it('locked when approvalType is REVIEW even with hasCurrent + hasDraft (approved-with-edits)', () => {
    const s = deriveReviewState({
      hasCurrent: true,
      hasDraft: true,
      approvalType: 'REVIEW',
      rejectedMessage: null,
    });
    expect(s.state).toBe('approved-with-edits');
    expect(s.locked).toBe(true);
    expect(s.lockReason).toBe('review-pending');
  });

  it('not locked when approvalType is null (not-submitted)', () => {
    const s = deriveReviewState({ ...base });
    expect(s.locked).toBe(false);
    expect(s.lockReason).toBeNull();
  });

  it('not locked when approvalType is not REVIEW', () => {
    const s = deriveReviewState({
      ...base,
      approvalType: 'APPROVED',
      hasCurrent: true,
      hasDraft: false,
    });
    expect(s.locked).toBe(false);
    expect(s.lockReason).toBeNull();
  });

  // `state` and `locked` are intentionally decoupled — see docs/api/mini-apps.md
  // "REVIEW lock 권위". An app can read as `state: 'approved'` (hasCurrent
  // true, no draft) while `approvalType` is still `REVIEW` because the
  // server flips it asynchronously. Pin the combo so a future refactor that
  // tries to "fix" the apparent inconsistency doesn't break the contract.
  it('keeps state and locked decoupled when approvalType=REVIEW with no fresh draft', () => {
    const s = deriveReviewState({
      hasCurrent: true,
      hasDraft: false,
      approvalType: 'REVIEW',
      rejectedMessage: null,
    });
    expect(s.state).toBe('approved');
    expect(s.locked).toBe(true);
    expect(s.lockReason).toBe('review-pending');
  });
});

// `reviewStateInputFrom` bridges `MiniAppDetail` (the `fetchMiniAppDetail`
// response) to `deriveReviewState`'s input shape — the glue that replaced
// the direct `/with-draft` envelope consumption after issue #219.
//
// `approvalType`/`rejectedMessage` are flat fields on `MiniAppDetail`
// itself (siblings of `miniApp`, not nested inside it) — a second live
// probe during verification caught an earlier draft's wrong assumption
// that they were nested, which would have silently derived `not-submitted`
// for every real app. These tests exercise the flat shape directly, since
// `fetchMiniAppDetail` (see mini-apps.test.ts) is what owns normalising the
// raw envelope down to this shape.
describe('reviewStateInputFrom', () => {
  it('passes approvalType/rejectedMessage through from the flat MiniAppDetail fields', () => {
    const input = reviewStateInputFrom({
      miniApp: { title: 'whatever' },
      isBeforeFirstReview: false,
      hasApproved: true,
      hasInReview: false,
      hasDraft: false,
      approvalType: 'APPROVED',
      rejectedMessage: null,
    });
    expect(input).toEqual({
      hasCurrent: true,
      hasDraft: false,
      approvalType: 'APPROVED',
      rejectedMessage: null,
    });
  });

  it('passes through null approvalType/rejectedMessage untouched', () => {
    const input = reviewStateInputFrom({
      miniApp: null,
      isBeforeFirstReview: true,
      hasApproved: false,
      hasInReview: false,
      hasDraft: false,
      approvalType: null,
      rejectedMessage: null,
    });
    expect(input.approvalType).toBeNull();
    expect(input.rejectedMessage).toBeNull();
    expect(input.hasCurrent).toBe(false);
  });

  it('surfaces a non-null rejectedMessage', () => {
    const input = reviewStateInputFrom({
      miniApp: { title: 'whatever' },
      isBeforeFirstReview: false,
      hasApproved: false,
      hasInReview: true,
      hasDraft: true,
      approvalType: 'REVIEW',
      rejectedMessage: 'violates policy X',
    });
    expect(input.rejectedMessage).toBe('violates policy X');
    expect(input.hasDraft).toBe(true);
  });

  it('does not read approvalType/rejectedMessage from miniApp even if present there', () => {
    // Regression guard for the exact bug the second live probe caught: a
    // stray approvalType/rejectedMessage nested inside miniApp (e.g. from a
    // stale fixture copy-pasted from the wrong shape) must NOT leak through
    // — the flat MiniAppDetail fields are the only source of truth.
    const input = reviewStateInputFrom({
      miniApp: { approvalType: 'REJECTED', rejectedMessage: 'nested, should be ignored' },
      isBeforeFirstReview: false,
      hasApproved: true,
      hasInReview: false,
      hasDraft: false,
      approvalType: 'APPROVED',
      rejectedMessage: null,
    });
    expect(input.approvalType).toBe('APPROVED');
    expect(input.rejectedMessage).toBeNull();
  });
});

describe('serviceStatusFor', () => {
  it('returns the string serviceStatus when present', () => {
    expect(serviceStatusFor({ serviceStatus: 'PREPARE' })).toBe('PREPARE');
    expect(serviceStatusFor({ serviceStatus: 'RUNNING' })).toBe('RUNNING');
  });

  it('returns undefined when missing or wrong-typed', () => {
    expect(serviceStatusFor(null)).toBeUndefined();
    expect(serviceStatusFor({})).toBeUndefined();
    expect(serviceStatusFor({ serviceStatus: 1 })).toBeUndefined();
  });
});

// `app ls`'s status column composes deriveReviewState (per-app /with-draft)
// with the workspace review-status entry's serviceStatus. The lock gate is
// authoritative on approvalType === 'REVIEW' (docs/api/mini-apps.md
// "REVIEW lock 권위") — the derived ladder labels alone are not the gate.
describe('deriveLsStatus', () => {
  const base = {
    state: 'approved' as const,
    approvalType: 'APPROVED' as string | null,
    rejectedMessage: null,
    hasCurrent: true,
    hasDraft: false,
    locked: false,
    lockReason: null as import('./app.js').LockReason | null,
  };

  it('returns unknown + unlocked when no with-draft is available', () => {
    expect(deriveLsStatus(null, undefined)).toEqual({
      status: 'unknown',
      locked: false,
      lockReason: null,
    });
  });

  it('locked + lockReason="review-pending" when approvalType === "REVIEW"', () => {
    expect(deriveLsStatus({ ...base, approvalType: 'REVIEW' }, 'PREPARE')).toEqual({
      status: 'approved',
      locked: true,
      lockReason: 'review-pending',
    });
  });

  it('not locked when approvalType is APPROVED', () => {
    expect(deriveLsStatus(base, 'PREPARE')).toEqual({
      status: 'approved',
      locked: false,
      lockReason: null,
    });
  });

  it('promotes approved → in-service when serviceStatus === "RUNNING"', () => {
    expect(deriveLsStatus(base, 'RUNNING').status).toBe('in-service');
  });

  it('promotes approved → in-service when serviceStatus === "OPENED" (documented live value)', () => {
    // `OPENED` is the documented live value (release --confirm → OPENED);
    // `RUNNING` is a tolerated alias. Both must promote, else a published
    // app returning OPENED would show as bare `approved`.
    expect(deriveLsStatus(base, 'OPENED').status).toBe('in-service');
  });

  it('does not promote approved when serviceStatus is PREPARE or unknown', () => {
    expect(deriveLsStatus(base, 'PREPARE').status).toBe('approved');
    expect(deriveLsStatus(base, undefined).status).toBe('approved');
    expect(deriveLsStatus(base, 'SOMETHING_ELSE').status).toBe('approved');
  });

  it('does not promote non-approved states even when RUNNING is reported', () => {
    // A workspace entry that reports RUNNING for an app whose with-draft
    // says under-review is internally inconsistent — trust with-draft.
    expect(
      deriveLsStatus(
        { ...base, state: 'under-review', approvalType: 'REVIEW', hasCurrent: false },
        'RUNNING',
      ).status,
    ).toBe('under-review');
  });

  it('forwards approved-with-edits with lock when both current and draft exist under REVIEW', () => {
    const row = deriveLsStatus(
      {
        state: 'approved-with-edits',
        approvalType: 'REVIEW',
        rejectedMessage: null,
        hasCurrent: true,
        hasDraft: true,
        locked: true,
        lockReason: 'review-pending' as import('./app.js').LockReason | null,
      },
      'RUNNING',
    );
    // Even though serviceStatus says RUNNING, the derived state is not
    // `approved` (it's `approved-with-edits`), so the in-service promotion
    // does not fire. Lock is on because approvalType === 'REVIEW'.
    expect(row).toEqual({
      status: 'approved-with-edits',
      locked: true,
      lockReason: 'review-pending',
    });
  });
});

// `compareMiniAppViews` (the engine behind the old `aitcc app show --diff`
// field-by-field comparison) was removed in issue #219 — the `/with-draft`
// endpoint it depended on for two independent draft/current payloads 404s,
// and the replacement (`fetchMiniAppDetail`) only exposes a single `miniApp`
// snapshot. Diffing that snapshot against itself would produce a misleading
// "no changes" result even when `hasDraft` is true, so `--diff` now reports
// the boolean flags plus `diffAvailable: false` instead (see app.ts
// `showCommand`). No replacement tests needed here — the flags are already
// covered by the `deriveReviewState`/`reviewStateInputFrom` blocks above.

describe('deriveDaysUntilExpiry', () => {
  // Anchor `now` to a fixed point so the floor() boundaries are deterministic.
  const now = Date.parse('2026-05-09T00:00:00Z');
  const day = 86_400_000;

  it('returns positive day count for future expiry (numeric ms epoch)', () => {
    expect(deriveDaysUntilExpiry({ expireTs: now + 30 * day }, now)).toBe(30);
  });

  it('returns 0 for an expiry within the same day window', () => {
    expect(deriveDaysUntilExpiry({ expireTs: now + day - 1 }, now)).toBe(0);
  });

  it('returns negative day count for past expiry (already expired)', () => {
    expect(deriveDaysUntilExpiry({ expireTs: now - 5 * day }, now)).toBe(-5);
  });

  it('parses ISO string `expireTs` (some endpoints round-trip dates as strings)', () => {
    const cert = { expireTs: '2026-06-08T00:00:00Z' }; // 30 days out
    expect(deriveDaysUntilExpiry(cert, now)).toBe(30);
  });

  it('returns null when `expireTs` is missing', () => {
    expect(deriveDaysUntilExpiry({}, now)).toBeNull();
  });

  it('returns null on garbage strings (no fallback to validUntil)', () => {
    // Deliberate: cert page chunk only references `expireTs`. Guessing
    // from `validUntil` would be making up data.
    expect(
      deriveDaysUntilExpiry({ expireTs: 'not-a-date', validUntil: '2027-04-01' }, now),
    ).toBeNull();
  });

  it('returns null on non-finite numbers', () => {
    expect(deriveDaysUntilExpiry({ expireTs: Number.NaN }, now)).toBeNull();
    expect(deriveDaysUntilExpiry({ expireTs: Number.POSITIVE_INFINITY }, now)).toBeNull();
  });
});

// `pickCertById` mirrors `app certs ls`'s id resolution (id || certId)
// because the server has been ambivalent on field naming. Comparison is
// string-coerced — a captured cert id like "42" must match the
// number-typed `id: 42` and vice versa, otherwise `app certs show` would
// silently say not-found on a cert that very much exists.
describe('pickCertById', () => {
  it('matches by `id` (string)', () => {
    const certs = [{ id: 'abc', name: 'one' }];
    expect(pickCertById(certs, 'abc')).toBe(certs[0]);
  });

  it('matches by `certId` fallback when `id` absent', () => {
    const certs = [{ certId: 'xyz', name: 'one' }];
    expect(pickCertById(certs, 'xyz')).toBe(certs[0]);
  });

  it('coerces number ids on either side', () => {
    const certs = [{ id: 42, name: 'one' }];
    expect(pickCertById(certs, '42')).toBe(certs[0]);
  });

  it('prefers `id` over `certId` when both are present', () => {
    const certs = [{ id: 'primary', certId: 'secondary' }];
    expect(pickCertById(certs, 'primary')).toBe(certs[0]);
    expect(pickCertById(certs, 'secondary')).toBeNull();
  });

  it('returns null on miss', () => {
    expect(pickCertById([{ id: 'a' }, { id: 'b' }], 'c')).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(pickCertById([], 'anything')).toBeNull();
  });

  it('returns null and does not throw on whitespace-only target', () => {
    expect(pickCertById([{ id: 'a' }], '   ')).toBeNull();
  });
});

// `augmentCertExpiry` accepts any of the three field shapes the server
// has emitted across captures (`expireTs` millis, `expiresAt` ISO,
// `validUntil` ISO) and is missing-field tolerant. Pinning the precedence
// here so a refactor doesn't silently start preferring a stale field.
describe('augmentCertExpiry', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('reads `expireTs` (millis since epoch)', () => {
    const ts = Date.parse('2026-01-11T00:00:00Z');
    const r = augmentCertExpiry({ expireTs: ts }, now);
    expect(r.expiresAtMs).toBe(ts);
    expect(r.daysUntilExpiry).toBe(10);
  });

  it('falls back to `expiresAt` (ISO) when `expireTs` is missing', () => {
    const r = augmentCertExpiry({ expiresAt: '2026-01-06T00:00:00Z' }, now);
    expect(r.daysUntilExpiry).toBe(5);
  });

  it('falls back to `validUntil` (ISO) when neither is present', () => {
    const r = augmentCertExpiry({ validUntil: '2026-02-01T00:00:00Z' }, now);
    expect(r.daysUntilExpiry).toBe(31);
  });

  it('prefers `expireTs` over the ISO fields', () => {
    const ts = Date.parse('2026-01-11T00:00:00Z');
    const r = augmentCertExpiry(
      { expireTs: ts, expiresAt: '2030-01-01T00:00:00Z', validUntil: '2031-01-01T00:00:00Z' },
      now,
    );
    expect(r.expiresAtMs).toBe(ts);
    expect(r.daysUntilExpiry).toBe(10);
  });

  it('preserves negative days for already-expired certs', () => {
    const r = augmentCertExpiry({ expireTs: Date.parse('2025-12-25T00:00:00Z') }, now);
    expect(r.daysUntilExpiry).toBe(-7);
  });

  it('treats expireTs: 0 as the Unix epoch, not as missing', () => {
    // Number.isFinite(0) === true, so 0 must round-trip as a real
    // (extremely-expired) timestamp rather than collapsing to "no expiry".
    const r = augmentCertExpiry({ expireTs: 0 }, now);
    expect(r.expiresAtMs).toBe(0);
    expect(typeof r.daysUntilExpiry).toBe('number');
    expect(r.daysUntilExpiry).toBeLessThan(0);
  });

  it('returns empty object when no expiry field is present', () => {
    expect(augmentCertExpiry({ id: 'abc' }, now)).toEqual({});
  });

  it('ignores wrong-typed fields without crashing', () => {
    expect(augmentCertExpiry({ expireTs: 'not-a-number' }, now)).toEqual({});
    expect(augmentCertExpiry({ expiresAt: 12345 }, now)).toEqual({});
  });

  it('ignores unparseable ISO strings rather than NaN-propagating', () => {
    expect(augmentCertExpiry({ expiresAt: 'definitely not a date' }, now)).toEqual({});
  });
});
