import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppManifest, ManifestError, resolveManifestPath } from './app-manifest.js';

// The manifest loader is the CLI's contract surface for config files, so
// each shape error needs to be asserted end-to-end (missing field, wrong
// type, empty strings). The file-existence dance + path resolution is
// also the easiest place to regress when "simplifying" the auto-detect
// fallback. Asserting against fixtures in a tmpdir is cheap and keeps
// these tests away from any ambient cwd pollution.

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-manifest-'));
}

function writeManifest(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('resolveManifestPath', () => {
  it('returns the explicit path when provided and it exists', async () => {
    const dir = makeTempDir();
    const path = writeManifest(dir, 'custom.yaml', 'titleKo: x\n');
    const resolved = await resolveManifestPath(path, dir);
    expect(resolved).toBe(resolve(path));
  });

  it('throws ManifestError when the explicit path does not exist', async () => {
    const dir = makeTempDir();
    await expect(resolveManifestPath(join(dir, 'missing.yaml'), dir)).rejects.toThrow(
      ManifestError,
    );
  });

  it('auto-detects ./aitcc.app.yaml over ./aitcc.app.json', async () => {
    const dir = makeTempDir();
    writeManifest(dir, 'aitcc.app.yaml', 'titleKo: yaml\n');
    writeManifest(dir, 'aitcc.app.json', '{"titleKo":"json"}');
    const resolved = await resolveManifestPath(undefined, dir);
    expect(resolved).toBe(resolve(join(dir, 'aitcc.app.yaml')));
  });

  it('falls back to aitcc.app.json when only json exists', async () => {
    const dir = makeTempDir();
    writeManifest(dir, 'aitcc.app.json', '{}');
    const resolved = await resolveManifestPath(undefined, dir);
    expect(resolved).toBe(resolve(join(dir, 'aitcc.app.json')));
  });

  it('throws ManifestError when no manifest is found', async () => {
    const dir = makeTempDir();
    await expect(resolveManifestPath(undefined, dir)).rejects.toThrow(/manifest/i);
  });
});

describe('loadAppManifest', () => {
  const fullManifestYaml = `
titleKo: SDK 레퍼런스
titleEn: SDK Reference
appName: ait-sdk-example
homePageUri: https://example.com/
csEmail: support@example.com
logo: ./assets/logo.png
logoDarkMode: ./assets/logo-dark.png
horizontalThumbnail: ./assets/thumb.png
categoryIds: [1, 2]
subtitle: 앱인토스 SDK 인터랙티브 예제
description: |-
  A long-form description of the app.
keywords: [sdk, example]
verticalScreenshots:
  - ./assets/s1.png
  - ./assets/s2.png
  - ./assets/s3.png
horizontalScreenshots:
  - ./assets/h1.png
`;

  it('parses a full YAML manifest and resolves image paths relative to the config file', async () => {
    const dir = makeTempDir();
    const path = writeManifest(dir, 'aitcc.app.yaml', fullManifestYaml);
    const manifest = await loadAppManifest(path);

    expect(manifest.titleKo).toBe('SDK 레퍼런스');
    expect(manifest.titleEn).toBe('SDK Reference');
    expect(manifest.appName).toBe('ait-sdk-example');
    expect(manifest.homePageUri).toBe('https://example.com/');
    expect(manifest.csEmail).toBe('support@example.com');
    expect(manifest.logo).toBe(resolve(join(dir, 'assets/logo.png')));
    expect(manifest.logoDarkMode).toBe(resolve(join(dir, 'assets/logo-dark.png')));
    expect(manifest.horizontalThumbnail).toBe(resolve(join(dir, 'assets/thumb.png')));
    expect(manifest.categoryIds).toEqual([1, 2]);
    expect(manifest.subtitle).toBe('앱인토스 SDK 인터랙티브 예제');
    expect(manifest.description).toBe('A long-form description of the app.');
    expect(manifest.keywords).toEqual(['sdk', 'example']);
    expect(manifest.verticalScreenshots).toEqual([
      resolve(join(dir, 'assets/s1.png')),
      resolve(join(dir, 'assets/s2.png')),
      resolve(join(dir, 'assets/s3.png')),
    ]);
    expect(manifest.horizontalScreenshots).toEqual([resolve(join(dir, 'assets/h1.png'))]);
  });

  it('parses a minimal JSON manifest (optional fields omitted)', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.json',
      JSON.stringify({
        titleKo: 'K',
        titleEn: 'Eng',
        appName: 'slug',
        csEmail: 'a@b.co',
        logo: 'logo.png',
        horizontalThumbnail: 'thumb.png',
        categoryIds: [1],
        subtitle: 's',
        description: 'd',
        verticalScreenshots: ['v1.png', 'v2.png', 'v3.png'],
      }),
    );
    const manifest = await loadAppManifest(path);
    expect(manifest.homePageUri).toBeUndefined();
    expect(manifest.logoDarkMode).toBeUndefined();
    expect(manifest.keywords).toEqual([]);
    expect(manifest.horizontalScreenshots).toEqual([]);
    expect(manifest.logo).toBe(resolve(join(dir, 'logo.png')));
  });

  it('throws ManifestError for a required-field miss (titleKo)', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      // titleKo missing
      `titleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1.png, v2.png, v3.png]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('titleKo');
    expect((err as ManifestError).kind).toBe('missing-required-field');
  });

  it('throws ManifestError for wrong types (categoryIds as string)', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: "not-an-array"\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).kind).toBe('invalid-config');
    expect((err as ManifestError).field).toBe('categoryIds');
  });

  it('throws ManifestError for empty string in a required field (titleKo blank)', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: ''\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).kind).toBe('missing-required-field');
    expect((err as ManifestError).field).toBe('titleKo');
  });

  it('throws ManifestError for malformed YAML', async () => {
    const dir = makeTempDir();
    const path = writeManifest(dir, 'aitcc.app.yaml', `::: not valid yaml :::\n:`);
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).kind).toBe('invalid-config');
  });

  it('throws ManifestError when keywords list exceeds 10 entries', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\nkeywords: [a,b,c,d,e,f,g,h,i,j,k]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('keywords');
  });

  it('throws ManifestError when subtitle exceeds 20 chars', async () => {
    const dir = makeTempDir();
    const twentyOne = 'a'.repeat(21);
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: ${twentyOne}\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('subtitle');
  });

  it('requires at least 3 vertical screenshots', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('verticalScreenshots');
  });

  it('rejects a non-email csEmail', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: not-an-email\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('csEmail');
    expect((err as ManifestError).kind).toBe('invalid-config');
  });

  it('rejects a non-http homePageUri', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nhomePageUri: javascript:alert(1)\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('homePageUri');
    expect((err as ManifestError).kind).toBe('invalid-config');
  });

  it('rejects titleEn with disallowed characters (dog-food #23 server rule)', async () => {
    // Console error: "앱 영문 이름은 영어, 숫자, 공백, 콜론(:)만 사용 가능해요" — captured
    // as HTTP 400 errorCode=4000. We pre-validate locally so agent-plugin
    // gets `invalid-config` instead of a passed-through `api-error`.
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: "Has-Hyphen"\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('titleEn');
    expect((err as ManifestError).kind).toBe('invalid-config');
  });

  it('accepts titleEn with English letters, digits, spaces, and colons', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: "SDK Reference: v2"\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const manifest = await loadAppManifest(path);
    expect(manifest.titleEn).toBe('SDK Reference: v2');
  });

  it('rejects description longer than 500 characters (dog-food #23 server rule)', async () => {
    // Console error: "앱 상세설명은 최대 500자를 넘어갈 수 없어요".
    const dir = makeTempDir();
    const tooLong = 'a'.repeat(501);
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: ${tooLong}\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('description');
    expect((err as ManifestError).kind).toBe('invalid-config');
  });

  it('counts description length by code points so emoji do not under-count', async () => {
    // A single 💡 is one code point but two UTF-16 units. Using
    // `[...str].length` keeps the CLI strict (matches or beats the
    // server's own count, whichever way it counts internally).
    const dir = makeTempDir();
    // 250 emoji = 250 code points, but 500 UTF-16 units. If we counted
    // .length naively we'd reject this; with code points it passes.
    const borderline = '💡'.repeat(250);
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: [1]\nsubtitle: s\ndescription: "${borderline}"\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const manifest = await loadAppManifest(path);
    expect([...manifest.description].length).toBe(250);
  });

  it('requires at least 1 category id', async () => {
    const dir = makeTempDir();
    const path = writeManifest(
      dir,
      'aitcc.app.yaml',
      `titleKo: k\ntitleEn: e\nappName: s\ncsEmail: a@b.co\nlogo: l.png\nhorizontalThumbnail: t.png\ncategoryIds: []\nsubtitle: s\ndescription: d\nverticalScreenshots: [v1, v2, v3]\n`,
    );
    const err = await loadAppManifest(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).field).toBe('categoryIds');
  });
});
