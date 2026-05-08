import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TossApiError } from '../api/http.js';
import {
  WORKSPACE_TERM_TYPES,
  type WorkspaceTerm,
  type WorkspaceTermType,
} from '../api/workspaces.js';
import { parsePositiveInt } from './_shared.js';
import {
  blocksFor,
  describeAgreeError,
  formatBlocksHint,
  processAgreeBuckets,
  TERM_BLOCKS,
  validateAgreeArgs,
} from './workspace.js';

// Regression guard for the strict workspace-id parser used by
// `workspace use` and `workspace show --workspace`. `Number.parseInt` alone
// accepts trailing garbage ("36577x" → 36577) which would silently persist
// the wrong id on a typo. Keep the parser strict.
describe('parsePositiveInt', () => {
  it('accepts canonical positive integers', () => {
    expect(parsePositiveInt('36577')).toBe(36577);
    expect(parsePositiveInt('1')).toBe(1);
  });

  it('rejects trailing garbage', () => {
    expect(parsePositiveInt('36577x')).toBeNull();
    expect(parsePositiveInt('36577 ')).toBeNull();
    expect(parsePositiveInt(' 36577')).toBeNull();
  });

  it('rejects zero and negatives', () => {
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-1')).toBeNull();
    expect(parsePositiveInt('+1')).toBeNull();
  });

  it('rejects empty and non-digit input', () => {
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('1e9')).toBeNull();
  });

  it('rejects leading-zero representations', () => {
    expect(parsePositiveInt('01')).toBeNull();
    expect(parsePositiveInt('0001')).toBeNull();
  });

  it('rejects values above Number.MAX_SAFE_INTEGER', () => {
    const tooBig = `${Number.MAX_SAFE_INTEGER}0`;
    expect(parsePositiveInt(tooBig)).toBeNull();
  });
});

// `aitcc workspace terms` decorates each bucket with a `blocks` list
// (feature surfaces gated by that bucket). The mapping is static and
// human-curated from docs/api/_error-codes.md — drift in the enum or in
// the table would silently de-document the gating, so the regression
// guards check both shape and a couple of representative entries.
describe('TERM_BLOCKS', () => {
  it('covers every workspace term type the API enumerates', () => {
    // If the server adds a new type and we forget to extend the table,
    // `formatBlocksHint` silently omits it. Keeping the table in lockstep
    // with the enum is the cheapest invariant to test.
    for (const type of WORKSPACE_TERM_TYPES) {
      expect(TERM_BLOCKS[type as WorkspaceTermType]).toBeDefined();
      expect(TERM_BLOCKS[type as WorkspaceTermType].length).toBeGreaterThan(0);
    }
  });

  it('maps the buckets the dog-food doc names', () => {
    expect(TERM_BLOCKS.BIZ_WORKSPACE).toEqual(
      expect.arrayContaining(['app register', 'app deploy']),
    );
    expect(TERM_BLOCKS.IAP).toEqual(expect.arrayContaining(['iap product register', 'iap config']));
  });
});

describe('blocksFor', () => {
  it('returns the mapped list for a known type', () => {
    expect(blocksFor('TOSS_LOGIN')).toBe(TERM_BLOCKS.TOSS_LOGIN);
  });

  it('returns an empty list for an unmapped type', () => {
    // Cast via `unknown` because the public type is the literal union;
    // we're simulating the "server added a new bucket before we did"
    // scenario the spec calls out. The runtime guard must not throw.
    const unknown = 'NEW_BUCKET' as unknown as WorkspaceTermType;
    expect(blocksFor(unknown)).toEqual([]);
  });
});

describe('formatBlocksHint', () => {
  let originalIsTTY: boolean | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalNoColor = process.env.NO_COLOR;
    // Default to non-TTY so the hint output is plain ASCII and easy to
    // diff. Individual tests opt into TTY when they want to check colors.
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it('renders a single hint line for an agreed term (no color)', () => {
    const out = formatBlocksHint('IAP', true);
    expect(out).toBe('    blocks if missing: iap product register, iap config\n');
  });

  it('renders a single hint line for a pending term in non-TTY (still no color)', () => {
    const out = formatBlocksHint('IAP', false);
    expect(out).toBe('    blocks if missing: iap product register, iap config\n');
  });

  it('returns an empty string for an unmapped type', () => {
    const unknown = 'NEW_BUCKET' as unknown as WorkspaceTermType;
    expect(formatBlocksHint(unknown, false)).toBe('');
  });

  it('emits ANSI yellow when pending + TTY + NO_COLOR unset', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    const out = formatBlocksHint('IAP', false);
    expect(out).toContain('\x1b[33m');
    expect(out).toContain('\x1b[0m');
    expect(out).toContain('blocks if missing: iap product register, iap config');
  });

  it('omits color when NO_COLOR is set even in TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    process.env.NO_COLOR = '1';
    const out = formatBlocksHint('IAP', false);
    expect(out).not.toContain('\x1b[');
  });

  it('does not color an agreed term in TTY but still renders the hint', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    const out = formatBlocksHint('IAP', true);
    expect(out).not.toContain('\x1b[');
    // Guard against a regression where `formatBlocksHint` returns '' for
    // agreed terms — agreed entries are supposed to render the hint in
    // default styling so users see the gating context regardless.
    expect(out).toContain('blocks if missing: iap product register, iap config');
  });
});

// `validateAgreeArgs` is the pure-arg gate before any session/network is
// touched. It owns the mutually-exclusive / argument-required /
// unknown-term-type branches that map straight to the JSON contract's
// `reason` field, plus the case-insensitive positional matching.
describe('validateAgreeArgs', () => {
  it('returns argument-required when neither positional nor --all is given', () => {
    const r = validateAgreeArgs({ positional: '', all: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('argument-required');
    }
  });

  it('returns mutually-exclusive when both positional and --all are given', () => {
    const r = validateAgreeArgs({ positional: 'IAP', all: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('mutually-exclusive');
    }
  });

  it('expands --all to every term type', () => {
    const r = validateAgreeArgs({ positional: '', all: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.types).toEqual(WORKSPACE_TERM_TYPES);
    }
  });

  it('accepts a known term type case-insensitively', () => {
    const r = validateAgreeArgs({ positional: 'iap', all: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.types).toEqual(['IAP']);
    }
  });

  it('returns unknown-term-type with given+allowed for an unknown positional', () => {
    const r = validateAgreeArgs({ positional: 'NOT_A_TYPE', all: false });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'unknown-term-type') {
      expect(r.given).toBe('NOT_A_TYPE');
      expect(r.allowed).toEqual([...WORKSPACE_TERM_TYPES]);
    }
  });
});

// `processAgreeBuckets` is the orchestration core: given fetched buckets +
// an injectable submitter, partition into agreed/unchanged/failed.
// Tests use a `WorkspaceTerm` factory so the snapshot input mimics what
// `fetchWorkspaceTerms` returns.
function term(
  termsId: number,
  revisionId: number,
  isAgreed: boolean,
  title = `term-${termsId}`,
): WorkspaceTerm {
  return {
    required: true,
    termsId,
    revisionId,
    title,
    contentsUrl: `https://terms/${termsId}/${revisionId}`,
    actionType: 'NONE',
    isAgreed,
    isOneTimeConsent: false,
  };
}

describe('processAgreeBuckets', () => {
  it('moves all-pending terms to agreed when submit succeeds', async () => {
    const submitted: { type: WorkspaceTermType; pending: readonly { termsId: number }[] }[] = [];
    const out = await processAgreeBuckets(
      [{ type: 'IAP', terms: [term(1, 10, false), term(2, 20, false)] }],
      async (type, pending) => {
        submitted.push({ type, pending: pending.map((p) => ({ termsId: p.termsId })) });
      },
    );
    expect(out.agreed.map((a) => a.termsId)).toEqual([1, 2]);
    expect(out.unchanged).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(submitted).toEqual([{ type: 'IAP', pending: [{ termsId: 1 }, { termsId: 2 }] }]);
  });

  it('moves already-agreed terms to unchanged and skips the API call entirely', async () => {
    let submitCalls = 0;
    const out = await processAgreeBuckets(
      [{ type: 'IAP', terms: [term(1, 10, true), term(2, 20, true)] }],
      async () => {
        submitCalls++;
      },
    );
    expect(submitCalls).toBe(0);
    expect(out.agreed).toEqual([]);
    expect(out.unchanged.map((u) => u.termsId)).toEqual([1, 2]);
    expect(out.failed).toEqual([]);
  });

  it('mixes agreed + unchanged within the same bucket', async () => {
    const out = await processAgreeBuckets(
      [{ type: 'IAP', terms: [term(1, 10, true), term(2, 20, false), term(3, 30, true)] }],
      async () => {},
    );
    expect(out.agreed.map((a) => a.termsId)).toEqual([2]);
    expect(out.unchanged.map((u) => u.termsId)).toEqual([1, 3]);
    expect(out.failed).toEqual([]);
  });

  it('records partial failure: one bucket fails, the next still proceeds', async () => {
    const apiErr = new TossApiError(200, '500', 'INTERNAL', 0);
    const out = await processAgreeBuckets(
      [
        { type: 'IAP', terms: [term(1, 10, false)] },
        { type: 'IAA', terms: [term(2, 20, false)] },
      ],
      async (type) => {
        if (type === 'IAP') throw apiErr;
      },
    );
    expect(out.agreed.map((a) => a.type)).toEqual(['IAA']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.type).toBe('IAP');
    // Message comes from `TossApiError.message` directly (no extra suffix):
    //   "Toss API error 500: INTERNAL (HTTP 200)"
    expect(out.failed[0]?.message).toBe('Toss API error 500: INTERNAL (HTTP 200)');
  });

  it('processes every requested bucket for the --all path', async () => {
    const calls: WorkspaceTermType[] = [];
    const buckets = WORKSPACE_TERM_TYPES.map((t, i) => ({
      type: t,
      terms: [term(i + 1, (i + 1) * 10, false)],
    }));
    const out = await processAgreeBuckets(buckets, async (type) => {
      calls.push(type);
    });
    expect(calls).toEqual([...WORKSPACE_TERM_TYPES]);
    expect(out.agreed).toHaveLength(WORKSPACE_TERM_TYPES.length);
    expect(out.unchanged).toEqual([]);
    expect(out.failed).toEqual([]);
  });
});

describe('describeAgreeError', () => {
  it('returns TossApiError.message verbatim (errorCode + reason already embedded)', () => {
    const err = new TossApiError(200, '500', 'INTERNAL', 0);
    expect(describeAgreeError(err)).toBe('Toss API error 500: INTERNAL (HTTP 200)');
  });

  it('renders generic Error.message', () => {
    expect(describeAgreeError(new Error('boom'))).toBe('boom');
  });

  it('coerces non-Error values to a string', () => {
    expect(describeAgreeError('weird')).toBe('weird');
  });
});
