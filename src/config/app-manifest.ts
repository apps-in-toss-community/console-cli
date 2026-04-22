import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// The app manifest is the CLI's user-facing contract for `aitcc app
// register`. It intentionally mirrors the console's form field names only
// at the top level — the inferred submit payload (which nests fields into
// step1/step2/miniApp/impression) is built by a separate payload module
// so the manifest shape is stable even if the bundle analysis turns out
// to be off. Dog-food task #23 is expected to correct the payload
// transformation but should not force a manifest rewrite.
//
// Validation here is "config shape only": presence, type, and cheap
// numeric/length constraints from `VALIDATION-RULES.md` that we can
// enforce without reading image files. Image-dimension checks live in a
// sibling module (`image-validator.ts`) because they need FS reads.
//
// ManifestError is a single error class carrying (kind, field?, path?)
// so the command layer can translate it into the documented `--json`
// error shapes without re-classifying.

export type ManifestErrorKind = 'invalid-config' | 'missing-required-field';

export class ManifestError extends Error {
  readonly kind: ManifestErrorKind;
  readonly field: string | undefined;

  constructor(kind: ManifestErrorKind, message: string, field?: string) {
    super(message);
    this.name = 'ManifestError';
    this.kind = kind;
    this.field = field;
  }
}

export interface AppManifest {
  readonly titleKo: string;
  readonly titleEn: string;
  readonly appName: string;
  readonly homePageUri: string | undefined;
  readonly csEmail: string;
  readonly logo: string;
  readonly logoDarkMode: string | undefined;
  readonly horizontalThumbnail: string;
  readonly categoryIds: readonly number[];
  readonly subtitle: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly verticalScreenshots: readonly string[];
  readonly horizontalScreenshots: readonly string[];
}

const DEFAULT_NAMES = ['aitcc.app.yaml', 'aitcc.app.json'] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the manifest file path. When `explicit` is provided, we use it
 * verbatim (resolved against `cwd`) and require it to exist. Otherwise we
 * auto-detect `aitcc.app.yaml` then `aitcc.app.json` under `cwd`.
 */
export async function resolveManifestPath(
  explicit: string | undefined,
  cwd: string,
): Promise<string> {
  if (explicit) {
    const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!(await fileExists(abs))) {
      throw new ManifestError('invalid-config', `manifest file not found at ${abs}`);
    }
    return abs;
  }
  for (const name of DEFAULT_NAMES) {
    const abs = resolve(cwd, name);
    if (await fileExists(abs)) return abs;
  }
  throw new ManifestError(
    'invalid-config',
    `no app manifest found (looked for ${DEFAULT_NAMES.join(', ')} in ${cwd})`,
  );
}

export async function loadAppManifest(path: string): Promise<AppManifest> {
  const raw = await readFile(path, 'utf8');
  const parsed = parseManifestFile(path, raw);
  return validateManifest(parsed, dirname(path));
}

function parseManifestFile(path: string, raw: string): Record<string, unknown> {
  const isJson = path.toLowerCase().endsWith('.json');
  try {
    const out = isJson ? JSON.parse(raw) : parseYaml(raw);
    if (out === null || typeof out !== 'object' || Array.isArray(out)) {
      throw new ManifestError('invalid-config', `manifest at ${path} is not a mapping`);
    }
    return out as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    const msg = (err as Error).message;
    throw new ManifestError('invalid-config', `failed to parse manifest at ${path}: ${msg}`);
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (v === undefined || v === null) {
    throw new ManifestError('missing-required-field', `${key} is required`, key);
  }
  if (typeof v !== 'string') {
    throw new ManifestError('invalid-config', `${key} must be a string`, key);
  }
  if (v.trim().length === 0) {
    throw new ManifestError('missing-required-field', `${key} is required`, key);
  }
  return v;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ManifestError('invalid-config', `${key} must be a string when provided`, key);
  }
  return v;
}

function requirePath(input: Record<string, unknown>, key: string, configDir: string): string {
  const rel = requireString(input, key);
  return isAbsolute(rel) ? rel : resolve(configDir, rel);
}

function optionalPath(
  input: Record<string, unknown>,
  key: string,
  configDir: string,
): string | undefined {
  const rel = optionalString(input, key);
  if (rel === undefined) return undefined;
  return isAbsolute(rel) ? rel : resolve(configDir, rel);
}

function requireNumberArray(
  input: Record<string, unknown>,
  key: string,
  { min }: { min: number },
): number[] {
  const v = input[key];
  if (!Array.isArray(v)) {
    throw new ManifestError('invalid-config', `${key} must be an array of numbers`, key);
  }
  if (v.length < min) {
    throw new ManifestError('invalid-config', `${key} must contain at least ${min} item(s)`, key);
  }
  return v.map((item, idx) => {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      throw new ManifestError('invalid-config', `${key}[${idx}] must be an integer`, key);
    }
    return item;
  });
}

function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  { max }: { max?: number } = {},
): string[] {
  const v = input[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new ManifestError('invalid-config', `${key} must be an array of strings`, key);
  }
  if (max !== undefined && v.length > max) {
    throw new ManifestError(
      'invalid-config',
      `${key} accepts at most ${max} entries (got ${v.length})`,
      key,
    );
  }
  return v.map((item, idx) => {
    if (typeof item !== 'string') {
      throw new ManifestError('invalid-config', `${key}[${idx}] must be a string`, key);
    }
    return item;
  });
}

function requirePathArray(
  input: Record<string, unknown>,
  key: string,
  configDir: string,
  { min }: { min: number },
): string[] {
  const v = input[key];
  if (!Array.isArray(v)) {
    throw new ManifestError('invalid-config', `${key} must be an array of paths`, key);
  }
  if (v.length < min) {
    throw new ManifestError('invalid-config', `${key} must contain at least ${min} item(s)`, key);
  }
  return v.map((item, idx) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ManifestError('invalid-config', `${key}[${idx}] must be a non-empty string`, key);
    }
    return isAbsolute(item) ? item : resolve(configDir, item);
  });
}

function optionalPathArray(
  input: Record<string, unknown>,
  key: string,
  configDir: string,
): string[] {
  const v = input[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new ManifestError('invalid-config', `${key} must be an array of paths`, key);
  }
  return v.map((item, idx) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ManifestError('invalid-config', `${key}[${idx}] must be a non-empty string`, key);
    }
    return isAbsolute(item) ? item : resolve(configDir, item);
  });
}

function validateManifest(raw: Record<string, unknown>, configDir: string): AppManifest {
  const titleKo = requireString(raw, 'titleKo');
  const titleEn = requireString(raw, 'titleEn');
  const appName = requireString(raw, 'appName');
  const csEmail = requireString(raw, 'csEmail');
  const subtitle = requireString(raw, 'subtitle');
  // subtitle ≤ 20 chars (F(20) in VALIDATION-RULES).
  if (subtitle.length > 20) {
    throw new ManifestError(
      'invalid-config',
      `subtitle must be 20 characters or fewer (got ${subtitle.length})`,
      'subtitle',
    );
  }
  const description = requireString(raw, 'description');
  const homePageUri = optionalString(raw, 'homePageUri');
  const logo = requirePath(raw, 'logo', configDir);
  const logoDarkMode = optionalPath(raw, 'logoDarkMode', configDir);
  const horizontalThumbnail = requirePath(raw, 'horizontalThumbnail', configDir);
  const categoryIds = requireNumberArray(raw, 'categoryIds', { min: 1 });
  const keywords = optionalStringArray(raw, 'keywords', { max: 10 });
  const verticalScreenshots = requirePathArray(raw, 'verticalScreenshots', configDir, { min: 3 });
  const horizontalScreenshots = optionalPathArray(raw, 'horizontalScreenshots', configDir);

  return {
    titleKo,
    titleEn,
    appName,
    homePageUri,
    csEmail,
    logo,
    logoDarkMode,
    horizontalThumbnail,
    categoryIds,
    subtitle,
    description,
    keywords,
    verticalScreenshots,
    horizontalScreenshots,
  };
}
