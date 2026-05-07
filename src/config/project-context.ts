import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
