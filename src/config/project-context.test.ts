import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findProjectContext,
  ProjectContextError,
  writeProjectMiniAppId,
} from './project-context.js';

// `findProjectContext` is the loader half of the project-context resolver
// (`resolveAppContext` is the policy half). Tests here pin the ancestor-
// walk semantics: cwd-first match, parent fallback, .git boundary, missing
// vs. malformed file. Done in tmpdirs to stay clear of the host's real
// `.git` (the umbrella worktree this runs from has one a few levels up).

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-project-ctx-'));
}

describe('findProjectContext', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    // Pin HOME outside the tmpdir so the walk halts at our synthetic
    // `.git` markers rather than wandering up the real filesystem to a
    // user-owned home that may contain unrelated config.
    process.env.HOME = '/__aitcc_test_home_does_not_exist__';
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('returns null when no aitcc.yaml is found before the git boundary', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(await findProjectContext(sub)).toBeNull();
  });

  it('parses workspaceId / miniAppId from cwd-level aitcc.yaml', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.yaml'), 'workspaceId: 3095\nminiAppId: 31146\n');
    const ctx = await findProjectContext(root);
    expect(ctx).toEqual({
      workspaceId: 3095,
      miniAppId: 31146,
      source: join(root, 'aitcc.yaml'),
    });
  });

  it('walks up the parent chain to find an aitcc.yaml in an ancestor dir', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.yaml'), 'workspaceId: 3095\n');
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const ctx = await findProjectContext(sub);
    expect(ctx?.workspaceId).toBe(3095);
    expect(ctx?.source).toBe(join(root, 'aitcc.yaml'));
  });

  it('prefers aitcc.yaml over aitcc.json in the same directory', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.yaml'), 'workspaceId: 1\n');
    writeFileSync(join(root, 'aitcc.json'), '{"workspaceId": 2}');
    const ctx = await findProjectContext(root);
    expect(ctx?.workspaceId).toBe(1);
  });

  it('parses aitcc.json when only json exists', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.json'), '{"workspaceId": 7, "miniAppId": 8}');
    const ctx = await findProjectContext(root);
    expect(ctx?.workspaceId).toBe(7);
    expect(ctx?.miniAppId).toBe(8);
  });

  it('does not cross the .git boundary', async () => {
    // outer/ has the yaml, but inner/.git stops the walk before we reach it.
    const outer = makeTempDir();
    writeFileSync(join(outer, '.git'), '');
    writeFileSync(join(outer, 'aitcc.yaml'), 'workspaceId: 1\n');
    const inner = join(outer, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, '.git'), '');
    const sub = join(inner, 'src');
    mkdirSync(sub);
    expect(await findProjectContext(sub)).toBeNull();
  });

  it('throws ProjectContextError on malformed yaml', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.yaml'), 'workspaceId: [unterminated\n');
    await expect(findProjectContext(root)).rejects.toThrow(ProjectContextError);
  });

  it('throws ProjectContextError when the file is not a mapping', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(join(root, 'aitcc.yaml'), '- 1\n- 2\n');
    await expect(findProjectContext(root)).rejects.toThrow(ProjectContextError);
  });

  it('drops non-positive-integer workspaceId / miniAppId but keeps source', async () => {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    writeFileSync(
      join(root, 'aitcc.yaml'),
      'workspaceId: "3095"\nminiAppId: -1\nappName: example\n',
    );
    const ctx = await findProjectContext(root);
    expect(ctx).toEqual({ source: join(root, 'aitcc.yaml') });
  });
});

describe('writeProjectMiniAppId', () => {
  it('appends miniAppId while preserving comments and key order in yaml', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    const original = `# project context\nworkspaceId: 3095 # community workspace\nappName: example\n`;
    writeFileSync(path, original);
    const outcome = await writeProjectMiniAppId(path, 31146);
    expect(outcome).toEqual({ status: 'written', path });
    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain('# project context');
    expect(updated).toContain('# community workspace');
    expect(updated).toContain('workspaceId: 3095');
    expect(updated).toContain('appName: example');
    expect(updated).toMatch(/miniAppId:\s+31146/);
  });

  it('replaces an existing miniAppId in yaml without rewriting unrelated keys', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    writeFileSync(path, `# header\nworkspaceId: 3095\nminiAppId: 100\nappName: example\n`);
    const outcome = await writeProjectMiniAppId(path, 31146);
    expect(outcome.status).toBe('written');
    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain('# header');
    expect(updated).toContain('miniAppId: 31146');
    expect(updated).not.toContain('miniAppId: 100');
  });

  it('reports unchanged when the yaml file already pins the same id', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    const original = `# header\nworkspaceId: 3095\nminiAppId: 31146\n`;
    writeFileSync(path, original);
    const outcome = await writeProjectMiniAppId(path, 31146);
    expect(outcome).toEqual({ status: 'unchanged', path });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('updates aitcc.json while preserving the existing indent and trailing newline', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.json');
    const original = `{\n    "workspaceId": 3095,\n    "appName": "example"\n}\n`;
    writeFileSync(path, original);
    const outcome = await writeProjectMiniAppId(path, 31146);
    expect(outcome.status).toBe('written');
    const updated = readFileSync(path, 'utf8');
    expect(updated.endsWith('\n')).toBe(true);
    // 4-space indent should survive.
    expect(updated).toContain('    "workspaceId": 3095');
    expect(updated).toContain('    "miniAppId": 31146');
    expect(JSON.parse(updated)).toEqual({
      workspaceId: 3095,
      appName: 'example',
      miniAppId: 31146,
    });
  });

  it('reports unchanged when aitcc.json already pins the same id', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.json');
    const original = `{"workspaceId":3095,"miniAppId":31146}`;
    writeFileSync(path, original);
    const outcome = await writeProjectMiniAppId(path, 31146);
    expect(outcome.status).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('throws ProjectContextError on a malformed yaml file', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    writeFileSync(path, 'workspaceId: [unterminated\n');
    await expect(writeProjectMiniAppId(path, 31146)).rejects.toThrow(ProjectContextError);
  });

  it('throws when the file is a sequence rather than a mapping', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    writeFileSync(path, '- a\n- b\n');
    await expect(writeProjectMiniAppId(path, 31146)).rejects.toThrow(ProjectContextError);
  });

  it('refuses to write a non-positive-integer id', async () => {
    const root = makeTempDir();
    const path = join(root, 'aitcc.yaml');
    writeFileSync(path, 'workspaceId: 3095\n');
    await expect(writeProjectMiniAppId(path, 0)).rejects.toThrow(ProjectContextError);
    await expect(writeProjectMiniAppId(path, -5)).rejects.toThrow(ProjectContextError);
    await expect(writeProjectMiniAppId(path, 1.5)).rejects.toThrow(ProjectContextError);
  });
});
