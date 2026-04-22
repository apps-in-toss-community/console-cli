import type { MiniAppImageEntry, MiniAppSubmitPayload } from '../api/mini-apps.js';
import type { AppManifest } from '../config/app-manifest.js';

// Pure transformation from a loaded AppManifest + the URLs produced by
// the upload step into the flat submit body. Shape confirmed via
// dog-food task #23 (2026-04-22): the server parses a flat top-level
// document that mirrors the persisted `app ls` row. The earlier
// `{miniApp, impression}` wrapper silently dropped every nested field.
// See `.playwright-mcp/FORM-SCHEMA-CAPTURED.md` in the umbrella for the
// raw capture.

export interface UploadedImageUrls {
  readonly logo: string;
  readonly logoDarkMode: string | undefined;
  readonly horizontalThumbnail: string;
  readonly verticalScreenshots: readonly string[];
  readonly horizontalScreenshots: readonly string[];
}

export function buildSubmitPayload(
  manifest: AppManifest,
  urls: UploadedImageUrls,
): MiniAppSubmitPayload {
  const images: MiniAppImageEntry[] = [
    { imageUrl: urls.horizontalThumbnail, imageType: 'THUMBNAIL', orientation: 'HORIZONTAL' },
    ...urls.verticalScreenshots.map<MiniAppImageEntry>((u) => ({
      imageUrl: u,
      imageType: 'PREVIEW',
      orientation: 'VERTICAL',
    })),
    ...urls.horizontalScreenshots.map<MiniAppImageEntry>((u) => ({
      imageUrl: u,
      imageType: 'PREVIEW',
      orientation: 'HORIZONTAL',
    })),
  ];

  return {
    title: manifest.titleKo,
    titleEn: manifest.titleEn,
    appName: manifest.appName,
    iconUri: urls.logo,
    status: 'PREPARE',
    csEmail: manifest.csEmail,
    description: manifest.subtitle,
    detailDescription: manifest.description,
    images,
    impression: {
      keywordList: manifest.keywords,
      categoryList: manifest.categoryIds.map((id) => ({ id })),
    },
    ...(urls.logoDarkMode !== undefined ? { darkModeIconUri: urls.logoDarkMode } : {}),
    ...(manifest.homePageUri !== undefined ? { homePageUri: manifest.homePageUri } : {}),
  };
}
