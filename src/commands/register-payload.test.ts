import { describe, expect, it } from 'vitest';
import type { AppManifest } from '../config/app-manifest.js';
import { buildSubmitPayload, type UploadedImageUrls } from './register-payload.js';

// The payload builder is a pure function — manifest + uploaded URLs in,
// flat submit body out. Shape confirmed via dog-food task #23 (2026-04-22):
// the server parses only top-level keys, and `impression` expects
// `categoryList: [{id}]` rather than `categoryIds: [number]`. See the
// umbrella `.playwright-mcp/FORM-SCHEMA-CAPTURED.md` for the raw capture.

const baseManifest: AppManifest = {
  titleKo: '테스트 앱',
  titleEn: 'Test App',
  appName: 'test-app',
  homePageUri: undefined,
  csEmail: 'a@b.co',
  logo: '/tmp/logo.png',
  logoDarkMode: undefined,
  horizontalThumbnail: '/tmp/thumb.png',
  categoryIds: [1, 2],
  subtitle: '한 줄 부제',
  description: '상세 설명',
  keywords: ['kw1', 'kw2'],
  verticalScreenshots: ['/tmp/v1.png', '/tmp/v2.png', '/tmp/v3.png'],
  horizontalScreenshots: [],
};

const baseUrls: UploadedImageUrls = {
  logo: 'https://cdn.example/logo.png',
  logoDarkMode: undefined,
  horizontalThumbnail: 'https://cdn.example/thumb.png',
  verticalScreenshots: [
    'https://cdn.example/v1.png',
    'https://cdn.example/v2.png',
    'https://cdn.example/v3.png',
  ],
  horizontalScreenshots: [],
};

describe('buildSubmitPayload', () => {
  it('produces a flat top-level payload mirroring the persisted app row', () => {
    const payload = buildSubmitPayload(baseManifest, baseUrls);
    expect(payload.title).toBe('테스트 앱');
    expect(payload.titleEn).toBe('Test App');
    expect(payload.appName).toBe('test-app');
    expect(payload.csEmail).toBe('a@b.co');
    expect(payload.iconUri).toBe('https://cdn.example/logo.png');
    expect(payload.status).toBe('PREPARE');
    // subtitle → description; long description → detailDescription.
    expect(payload.description).toBe('한 줄 부제');
    expect(payload.detailDescription).toBe('상세 설명');
    // No nested `miniApp` wrapper (dog-food #23: the wrapped form dropped
    // everything except top-level keys).
    expect('miniApp' in payload).toBe(false);
  });

  it('nests impression with categoryList objects + keywordList', () => {
    const payload = buildSubmitPayload(baseManifest, baseUrls);
    // `categoryList: [{id}]` is what the persisted row shows — the old
    // `categoryIds: [number]` form silently dropped on submit.
    expect(payload.impression.categoryList).toEqual([{ id: 1 }, { id: 2 }]);
    expect(payload.impression.keywordList).toEqual(['kw1', 'kw2']);
    expect('categoryIds' in payload.impression).toBe(false);
  });

  it('omits darkModeIconUri / homePageUri when the manifest has no value', () => {
    const payload = buildSubmitPayload(baseManifest, baseUrls);
    expect('darkModeIconUri' in payload).toBe(false);
    expect('homePageUri' in payload).toBe(false);
  });

  it('includes darkModeIconUri / homePageUri when set', () => {
    const payload = buildSubmitPayload(
      { ...baseManifest, homePageUri: 'https://example.com/' },
      { ...baseUrls, logoDarkMode: 'https://cdn.example/logo-dark.png' },
    );
    expect(payload.darkModeIconUri).toBe('https://cdn.example/logo-dark.png');
    expect(payload.homePageUri).toBe('https://example.com/');
  });

  it('renders images as THUMBNAIL/HORIZONTAL + PREVIEW/(VERTICAL|HORIZONTAL) rows in order', () => {
    const payload = buildSubmitPayload(
      { ...baseManifest, horizontalScreenshots: ['/tmp/h1.png'] },
      {
        ...baseUrls,
        horizontalScreenshots: ['https://cdn.example/h1.png'],
      },
    );
    const images = payload.images;
    expect(images[0]).toEqual({
      imageUrl: 'https://cdn.example/thumb.png',
      imageType: 'THUMBNAIL',
      orientation: 'HORIZONTAL',
    });
    expect(images.slice(1, 4)).toEqual([
      { imageUrl: 'https://cdn.example/v1.png', imageType: 'PREVIEW', orientation: 'VERTICAL' },
      { imageUrl: 'https://cdn.example/v2.png', imageType: 'PREVIEW', orientation: 'VERTICAL' },
      { imageUrl: 'https://cdn.example/v3.png', imageType: 'PREVIEW', orientation: 'VERTICAL' },
    ]);
    expect(images[4]).toEqual({
      imageUrl: 'https://cdn.example/h1.png',
      imageType: 'PREVIEW',
      orientation: 'HORIZONTAL',
    });
  });
});
