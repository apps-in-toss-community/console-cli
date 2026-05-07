import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isMap, parseDocument, parse as parseYaml } from 'yaml';

// Project-level context (workspace + active mini-app) discovered by walking
// from the cwd up to the nearest git repo root. Read by every app-scoped
// command so the user does not have to repeat `--workspace` and `<appId>`
// on each invocation. Distinct from `app-manifest.ts`: the manifest is the
// `register`/`update` payload contract, while the project context is the
// resolver input that picks *which* app/workspace a given command targets.

const DEFAULT_NAMES = ['aitcc.yaml', 'aitcc.json'] as const;
const MAX_HOPS = 32;

export interface ProjectContext {
  readonly workspaceId?: number;
  readonly miniAppId?: number;
  /** Absolute path of the file the context was read from (for diagnostics). */
  readonly source: string;
}

export class ProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectContextError';
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findContextFile(startDir: string): Promise<string | null> {
  let dir = startDir;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  for (let i = 0; i < MAX_HOPS; i++) {
    for (const name of DEFAULT_NAMES) {
      const candidate = join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
    // Stop walking when we hit a git repo boundary. `.git` may be a
    // directory (normal repo) or a file (submodule/worktree); `access`
    // succeeds for both.
    if (await fileExists(join(dir, '.git'))) return null;
    if (home && dir === home) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function pickPositiveInt(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return undefined;
  return v;
}

/**
 * Walk from `cwd` upward looking for `aitcc.yaml`/`aitcc.json`. Returns the
 * parsed `ProjectContext` of the first match, or `null` when no file is
 * found. Walks halt at the enclosing `.git` boundary or `$HOME`, whichever
 * comes first.
 *
 * Throws `ProjectContextError` when a file is found but cannot be parsed —
 * a present-but-broken config is more useful as a hard error than as a
 * silent miss. Unknown / mistyped fields (`workspaceId`, `miniAppId` not
 * being a positive integer) are dropped silently while preserving `source`.
 */
export async function findProjectContext(cwd: string): Promise<ProjectContext | null> {
  const path = await findContextFile(cwd);
  if (!path) return null;
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = path.toLowerCase().endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProjectContextError(`failed to parse project context at ${path}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectContextError(`project context at ${path} is not a mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  const workspaceId = pickPositiveInt(obj, 'workspaceId');
  const miniAppId = pickPositiveInt(obj, 'miniAppId');
  return {
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(miniAppId !== undefined ? { miniAppId } : {}),
    source: path,
  };
}

export type WriteMiniAppIdOutcome =
  | { readonly status: 'written'; readonly path: string }
  | { readonly status: 'unchanged'; readonly path: string };

/**
 * Persist `miniAppId` into an existing project-context file at `path`.
 *
 * - YAML files are updated via `parseDocument` so user comments, key
 *   ordering, and quoting style survive the round-trip. Only the
 *   `miniAppId` scalar is touched (added if absent, replaced if present).
 * - JSON files are parsed, mutated, and re-serialized with the indent the
 *   file already used (detected from the first indented line, defaulting
 *   to 2). The trailing newline is preserved if it was present.
 * - When the file already pins the same `miniAppId`, the write is a
 *   no-op and `status` is `"unchanged"` so callers can suppress the
 *   diagnostic line.
 *
 * Throws `ProjectContextError` when the file is missing, unparseable, or
 * not a top-level mapping. Caller is responsible for the "no project
 * file at all" case (`findProjectContext` returns `null`).
 */
export async function writeProjectMiniAppId(
  path: string,
  miniAppId: number,
): Promise<WriteMiniAppIdOutcome> {
  if (!Number.isInteger(miniAppId) || miniAppId <= 0) {
    throw new ProjectContextError(`refusing to write non-positive-integer miniAppId: ${miniAppId}`);
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProjectContextError(`failed to read project context at ${path}: ${detail}`);
  }
  const isJson = path.toLowerCase().endsWith('.json');
  const next = isJson ? rewriteJson(path, raw, miniAppId) : rewriteYaml(path, raw, miniAppId);
  if (next === null) return { status: 'unchanged', path };
  await writeFile(path, next, 'utf8');
  return { status: 'written', path };
}

function rewriteYaml(path: string, raw: string, miniAppId: number): string | null {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new ProjectContextError(
      `failed to parse project context at ${path}: ${doc.errors[0]?.message ?? 'parse error'}`,
    );
  }
  if (!isMap(doc.contents)) {
    throw new ProjectContextError(`project context at ${path} is not a mapping`);
  }
  const existing = doc.get('miniAppId');
  if (typeof existing === 'number' && existing === miniAppId) return null;
  doc.set('miniAppId', miniAppId);
  return doc.toString();
}

function rewriteJson(path: string, raw: string, miniAppId: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProjectContextError(`failed to parse project context at ${path}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectContextError(`project context at ${path} is not a mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.miniAppId === miniAppId) return null;
  obj.miniAppId = miniAppId;
  const indent = detectJsonIndent(raw);
  const trailing = raw.endsWith('\n') ? '\n' : '';
  return JSON.stringify(obj, null, indent) + trailing;
}

// Returns the original file's indentation token so JSON.stringify can
// reproduce it (number = spaces, string = literal token, e.g. '\t').
// `0` keeps a single-line / compact file compact instead of expanding
// it to multi-line on a one-key edit. Default is two spaces, matching
// the format examples in README and existing repo style.
function detectJsonIndent(raw: string): number | string {
  if (!raw.includes('\n')) return 0;
  const match = raw.match(/\n([ \t]+)\S/);
  const token = match?.[1];
  if (!token) return 2;
  if (token.includes('\t')) return '\t';
  return token.length;
}
