import type { MiniAppImageEntry, MiniAppSubmitPayload } from '../api/mini-apps.js';
import type { AppManifest } from '../config/app-manifest.js';

// Pure transformation from a loaded AppManifest + the URLs produced by
// the upload step into the `{miniApp, impression}` submit body. The
// structure mirrors the `Xc` function from the console bundle (see
// VALIDATION-RULES.md in the local `.playwright-mcp/`). Dog-food task
// #23 captures the first real network exchange and will either confirm
// this shape or correct it here.

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

  const miniApp: MiniAppSubmitPayload['miniApp'] = {
    title: manifest.titleKo,
    titleEn: manifest.titleEn,
    appName: manifest.appName,
    iconUri: urls.logo,
    status: 'PREPARE',
    csEmail: manifest.csEmail,
    description: manifest.subtitle,
    detailDescription: manifest.description,
    images,
    ...(urls.logoDarkMode !== undefined ? { darkModeIconUri: urls.logoDarkMode } : {}),
    ...(manifest.homePageUri !== undefined ? { homePageUri: manifest.homePageUri } : {}),
  };

  const impression: MiniAppSubmitPayload['impression'] = {
    keywordList: manifest.keywords,
    categoryIds: manifest.categoryIds,
  };

  return { miniApp, impression };
}
