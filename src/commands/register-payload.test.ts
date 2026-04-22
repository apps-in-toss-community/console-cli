import { describe, expect, it } from 'vitest';
import type { AppManifest } from '../config/app-manifest.js';
import { buildSubmitPayload, type UploadedImageUrls } from './register-payload.js';

// The payload builder is a pure function — manifest + uploaded URLs in,
// inferred submit body out. Dog-food task #23 will be the first real
// submission and may force tweaks; keeping the transformation pure means
// the diff will be confined here.

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
  it('wires manifest scalar fields into miniApp + impression sections', () => {
    const payload = buildSubmitPayload(baseManifest, baseUrls);
    expect(payload.miniApp.title).toBe('테스트 앱');
    expect(payload.miniApp.titleEn).toBe('Test App');
    expect(payload.miniApp.appName).toBe('test-app');
    expect(payload.miniApp.csEmail).toBe('a@b.co');
    expect(payload.miniApp.iconUri).toBe('https://cdn.example/logo.png');
    expect(payload.miniApp.status).toBe('PREPARE');
    // description (subtitle in manifest) goes to miniApp.description; the
    // long-form description becomes detailDescription. This mirrors the
    // bundle-extracted `Xc` function.
    expect(payload.miniApp.description).toBe('한 줄 부제');
    expect(payload.miniApp.detailDescription).toBe('상세 설명');
    expect(payload.impression.keywordList).toEqual(['kw1', 'kw2']);
    expect(payload.impression.categoryIds).toEqual([1, 2]);
  });

  it('omits darkModeIconUri / homePageUri when the manifest has no value', () => {
    const payload = buildSubmitPayload(baseManifest, baseUrls);
    expect('darkModeIconUri' in payload.miniApp).toBe(false);
    expect('homePageUri' in payload.miniApp).toBe(false);
  });

  it('includes darkModeIconUri / homePageUri when set', () => {
    const payload = buildSubmitPayload(
      { ...baseManifest, homePageUri: 'https://example.com/' },
      { ...baseUrls, logoDarkMode: 'https://cdn.example/logo-dark.png' },
    );
    expect(payload.miniApp.darkModeIconUri).toBe('https://cdn.example/logo-dark.png');
    expect(payload.miniApp.homePageUri).toBe('https://example.com/');
  });

  it('renders images as THUMBNAIL/HORIZONTAL + PREVIEW/(VERTICAL|HORIZONTAL) rows in the documented order', () => {
    const payload = buildSubmitPayload(
      { ...baseManifest, horizontalScreenshots: ['/tmp/h1.png'] },
      {
        ...baseUrls,
        horizontalScreenshots: ['https://cdn.example/h1.png'],
      },
    );
    const images = payload.miniApp.images;
    // Thumbnail always first (bundle order), then all vertical previews,
    // then horizontal previews.
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
