import { describe, expect, it } from 'vitest';
import { validateCreateIapProductArgs } from './app-iap.js';

// Field-level rules are pinned against the console SPA's IAPProductEditor
// react-hook-form `rules` (name<=30, description<=45, price 400..1_400_000,
// renewalCycle required iff SUBSCRIPTION) — see src/api/in-app-purchase.ts
// module comment for the exact source lines this mirrors.

const baseValidInput = {
  type: 'CONSUMABLE',
  name: 'coin pack',
  description: '100 coins',
  price: '1000',
  iconImgUrl: 'https://cdn.example/icon.png',
  minDeploymentId: '7',
  postInspectionStatus: 'INACTIVE',
  renewalCycle: undefined,
};

describe('validateCreateIapProductArgs', () => {
  it('accepts a well-formed CONSUMABLE input', () => {
    const result = validateCreateIapProductArgs(baseValidInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        type: 'CONSUMABLE',
        name: 'coin pack',
        description: '100 coins',
        price: 1000,
        iconImgUrl: 'https://cdn.example/icon.png',
        minDeploymentId: 7,
        postInspectionStatus: 'INACTIVE',
      });
    }
  });

  it('rejects an unknown --type', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, type: 'BUNDLE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('type');
  });

  it('requires --name and rejects >30 chars', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, name: undefined }).ok).toBe(false);
    const tooLong = validateCreateIapProductArgs({ ...baseValidInput, name: 'x'.repeat(31) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('name');
    expect(validateCreateIapProductArgs({ ...baseValidInput, name: 'x'.repeat(30) }).ok).toBe(true);
  });

  it('requires --description and rejects >45 chars', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, description: undefined }).ok).toBe(
      false,
    );
    const tooLong = validateCreateIapProductArgs({
      ...baseValidInput,
      description: 'x'.repeat(46),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('description');
    expect(
      validateCreateIapProductArgs({ ...baseValidInput, description: 'x'.repeat(45) }).ok,
    ).toBe(true);
  });

  it('enforces the 400..1,400,000 KRW price range', () => {
    const tooLow = validateCreateIapProductArgs({ ...baseValidInput, price: '399' });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.field).toBe('price');

    const tooHigh = validateCreateIapProductArgs({ ...baseValidInput, price: '1400001' });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.field).toBe('price');

    expect(validateCreateIapProductArgs({ ...baseValidInput, price: '400' }).ok).toBe(true);
    expect(validateCreateIapProductArgs({ ...baseValidInput, price: '1400000' }).ok).toBe(true);
  });

  it('rejects a non-integer price', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, price: '1000.5' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('price');
  });

  it('requires --icon-img-url', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, iconImgUrl: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('icon-img-url');
  });

  it('requires a positive integer --min-deployment-id', () => {
    expect(validateCreateIapProductArgs({ ...baseValidInput, minDeploymentId: undefined }).ok).toBe(
      false,
    );
    const zero = validateCreateIapProductArgs({ ...baseValidInput, minDeploymentId: '0' });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.field).toBe('min-deployment-id');
  });

  it('rejects an unknown --post-inspection-status', () => {
    const result = validateCreateIapProductArgs({
      ...baseValidInput,
      postInspectionStatus: 'PENDING',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('post-inspection-status');
  });

  it('requires --renewal-cycle when --type is SUBSCRIPTION', () => {
    const missing = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: undefined,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.field).toBe('renewal-cycle');

    const provided = validateCreateIapProductArgs({
      ...baseValidInput,
      type: 'SUBSCRIPTION',
      renewalCycle: 'MONTHLY',
    });
    expect(provided.ok).toBe(true);
    if (provided.ok) expect(provided.value.renewalCycle).toBe('MONTHLY');
  });

  it('rejects an unknown --renewal-cycle even for non-subscription types', () => {
    const result = validateCreateIapProductArgs({ ...baseValidInput, renewalCycle: 'DAILY' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('renewal-cycle');
  });

  it('omits renewalCycle from the validated value for non-subscription types', () => {
    const result = validateCreateIapProductArgs(baseValidInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.renewalCycle).toBeUndefined();
  });
});
