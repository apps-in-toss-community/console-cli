import { describe, expect, it } from 'vitest';
import { versionFromTag } from './github.js';
import { detectPlatform } from './platform.js';
import { compareSemver, parseSemver } from './semver.js';

describe('semver', () => {
  it('parses basic versions', () => {
    expect(parseSemver('0.1.2')).toEqual({ major: 0, minor: 1, patch: 2, pre: '' });
    expect(parseSemver('1.0.0-rc.1')).toEqual({ major: 1, minor: 0, patch: 0, pre: 'rc.1' });
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compares versions', () => {
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1);
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1);
  });
});

describe('github.versionFromTag', () => {
  it('strips `v` prefix', () => {
    expect(versionFromTag('v0.1.2')).toBe('0.1.2');
  });

  it('extracts from scoped package tag', () => {
    expect(versionFromTag('@ait-co/console-cli@0.1.2')).toBe('0.1.2');
  });

  it('returns tag as-is when already bare', () => {
    expect(versionFromTag('0.1.2')).toBe('0.1.2');
  });
});

describe('platform.detectPlatform', () => {
  it('produces the asset name shape the release workflow emits', () => {
    // We can't override process.platform on every CI runner, but the function
    // must return *something* on supported hosts, and that something must
    // match the pattern `ait-console-<os>-<arch>[.exe]`.
    const result = detectPlatform();
    if (result === null) return; // unsupported host, skip
    expect(result.assetName).toMatch(/^ait-console-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/);
    expect(result.assetName.includes(result.os)).toBe(true);
    expect(result.assetName.includes(result.arch)).toBe(true);
  });
});
