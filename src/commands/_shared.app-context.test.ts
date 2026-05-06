import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppContextError, resolveAppContext } from './_shared.js';

// `resolveAppContext` glues flag input, env vars, the discovered yaml, and
// the persisted session into a single context. The priority chain is the
// public contract that agent-plugin will rely on (PR 1b wires it into the
// commands), so each tier and the conflict-drop rule needs an explicit
// pinning test.

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aitcc-app-ctx-'));
}

describe('resolveAppContext', () => {
  const original = {
    home: process.env.HOME,
    workspace: process.env.AITCC_WORKSPACE,
    app: process.env.AITCC_APP,
  };

  beforeEach(() => {
    // Halt the ancestor walk inside the tmpdir so we don't pick up any
    // ambient aitcc.yaml from the host filesystem.
    process.env.HOME = '/__aitcc_test_home_does_not_exist__';
    delete process.env.AITCC_WORKSPACE;
    delete process.env.AITCC_APP;
  });

  afterEach(() => {
    process.env.HOME = original.home;
    if (original.workspace === undefined) delete process.env.AITCC_WORKSPACE;
    else process.env.AITCC_WORKSPACE = original.workspace;
    if (original.app === undefined) delete process.env.AITCC_APP;
    else process.env.AITCC_APP = original.app;
  });

  function emptyRepo(): string {
    const root = makeTempDir();
    writeFileSync(join(root, '.git'), '');
    return root;
  }

  it('uses the flag workspace when provided', async () => {
    const cwd = emptyRepo();
    const ctx = await resolveAppContext({ flagWorkspaceId: 100, cwd });
    expect(ctx).toMatchObject({ workspaceId: 100, workspaceSource: 'flag' });
    expect(ctx.miniAppId).toBeUndefined();
  });

  it('falls back to AITCC_WORKSPACE when no flag is given', async () => {
    process.env.AITCC_WORKSPACE = '200';
    const cwd = emptyRepo();
    const ctx = await resolveAppContext({ cwd });
    expect(ctx).toMatchObject({ workspaceId: 200, workspaceSource: 'env' });
  });

  it('falls back to yaml workspaceId when no flag/env is given', async () => {
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: 300\nminiAppId: 31146\n');
    const ctx = await resolveAppContext({ cwd });
    expect(ctx).toMatchObject({
      workspaceId: 300,
      workspaceSource: 'yaml',
      miniAppId: 31146,
      miniAppIdSource: 'yaml',
    });
    expect(ctx.projectFile).toBe(join(cwd, 'aitcc.yaml'));
  });

  it('falls back to session.currentWorkspaceId last', async () => {
    const cwd = emptyRepo();
    const ctx = await resolveAppContext({ sessionWorkspaceId: 400, cwd });
    expect(ctx).toMatchObject({ workspaceId: 400, workspaceSource: 'session' });
  });

  it('flag beats env, env beats yaml, yaml beats session', async () => {
    process.env.AITCC_WORKSPACE = '20';
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: 30\n');

    const flag = await resolveAppContext({ flagWorkspaceId: 10, sessionWorkspaceId: 40, cwd });
    expect(flag.workspaceSource).toBe('flag');
    expect(flag.workspaceId).toBe(10);

    const env = await resolveAppContext({ sessionWorkspaceId: 40, cwd });
    expect(env.workspaceSource).toBe('env');
    expect(env.workspaceId).toBe(20);

    delete process.env.AITCC_WORKSPACE;
    const yaml = await resolveAppContext({ sessionWorkspaceId: 40, cwd });
    expect(yaml.workspaceSource).toBe('yaml');
    expect(yaml.workspaceId).toBe(30);

    // Removing the yaml leaves only the session as a source.
    writeFileSync(join(cwd, 'aitcc.yaml'), '\n');
    const session = await resolveAppContext({ sessionWorkspaceId: 40, cwd });
    expect(session.workspaceSource).toBe('session');
    expect(session.workspaceId).toBe(40);
  });

  it('throws AppContextError when no source provides a workspace', async () => {
    const cwd = emptyRepo();
    await expect(resolveAppContext({ cwd })).rejects.toBeInstanceOf(AppContextError);
  });

  it('throws AppContextError on a malformed AITCC_WORKSPACE', async () => {
    process.env.AITCC_WORKSPACE = '36577x';
    const cwd = emptyRepo();
    await expect(resolveAppContext({ cwd })).rejects.toThrow(/AITCC_WORKSPACE/);
  });

  it('drops yaml miniAppId when --workspace flag overrides the workspace', async () => {
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: 300\nminiAppId: 31146\n');
    const ctx = await resolveAppContext({ flagWorkspaceId: 999, cwd });
    expect(ctx.workspaceId).toBe(999);
    expect(ctx.workspaceSource).toBe('flag');
    expect(ctx.miniAppId).toBeUndefined();
    expect(ctx.miniAppIdSource).toBeUndefined();
  });

  it('keeps yaml miniAppId when env overrides workspace (env != flag)', async () => {
    process.env.AITCC_WORKSPACE = '999';
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: 300\nminiAppId: 31146\n');
    const ctx = await resolveAppContext({ cwd });
    // env-sourced workspace doesn't drop yaml miniApp — env is the user
    // explicitly opting into "use this workspace from now on" without
    // making a per-command override. The drop rule is scoped to `flag`.
    expect(ctx.miniAppId).toBe(31146);
    expect(ctx.miniAppIdSource).toBe('yaml');
  });

  it('flag miniApp wins over env and yaml miniApp', async () => {
    process.env.AITCC_APP = '2';
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: 1\nminiAppId: 3\n');
    const ctx = await resolveAppContext({ flagMiniAppId: 1, cwd });
    expect(ctx.miniAppId).toBe(1);
    expect(ctx.miniAppIdSource).toBe('flag');
  });

  it('treats a broken yaml as no project context (does not throw)', async () => {
    const cwd = emptyRepo();
    writeFileSync(join(cwd, 'aitcc.yaml'), 'workspaceId: [unterminated\n');
    const ctx = await resolveAppContext({ flagWorkspaceId: 5, cwd });
    expect(ctx.workspaceId).toBe(5);
    expect(ctx.projectFile).toBeUndefined();
  });
});
