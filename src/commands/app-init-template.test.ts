import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { findProjectContext } from '../config/project-context.js';
import { type InitAnswers, renderInitYaml } from './app-init-template.js';

const baseAnswers: InitAnswers = {
  workspaceId: 3095,
  titleKo: '푸 SDK',
  titleEn: 'Foo Sdk',
  appName: 'aitc-foo',
  csEmail: 'dave@elyvian.io',
  subtitle: '푸 SDK 데모',
  description: 'Line 1\nLine 2',
  categoryIds: [3882],
};

describe('renderInitYaml', () => {
  it('emits a header, required fields, and a commented-out optional block', () => {
    const out = renderInitYaml(baseAnswers);
    expect(out).toContain('# Project context');
    expect(out).toContain('workspaceId: 3095');
    expect(out).toContain('titleKo: "푸 SDK"');
    expect(out).toContain('titleEn: "Foo Sdk"');
    expect(out).toContain('appName: aitc-foo');
    expect(out).toContain('csEmail: dave@elyvian.io');
    expect(out).toContain('subtitle: "푸 SDK 데모"');
    expect(out).toContain('description: |-\n  Line 1\n  Line 2');
    expect(out).toContain('categoryIds: [3882]');
    expect(out).toContain('logo: ./assets/logo.png');
    expect(out).toContain('horizontalThumbnail: ./assets/thumbnail.png');
    expect(out).toContain('  - ./assets/screenshot-1.png');
    expect(out).toContain('# homePageUri:');
    expect(out).toContain('# logoDarkMode:');
    expect(out).toContain('# keywords:');
    expect(out).toContain('# horizontalScreenshots:');
  });

  it('escapes embedded double quotes and backslashes in quoted scalars', () => {
    const out = renderInitYaml({
      ...baseAnswers,
      titleKo: 'A"B\\C',
    });
    expect(out).toContain('titleKo: "A\\"B\\\\C"');
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(doc.get('titleKo')).toBe('A"B\\C');
  });

  it('joins multiple categoryIds with comma-space', () => {
    const out = renderInitYaml({ ...baseAnswers, categoryIds: [3882, 4001, 4055] });
    expect(out).toContain('categoryIds: [3882, 4001, 4055]');
  });

  it('produces yaml that round-trips through findProjectContext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aitcc-init-'));
    // Use a `.git` marker so the walk stops at this dir.
    mkdirSync(join(dir, '.git'));
    const yaml = renderInitYaml(baseAnswers);
    writeFileSync(join(dir, 'aitcc.yaml'), yaml, 'utf8');
    const ctx = await findProjectContext(dir);
    expect(ctx).not.toBeNull();
    expect(ctx?.workspaceId).toBe(3095);
    expect(ctx?.miniAppId).toBeUndefined();
  });
});
