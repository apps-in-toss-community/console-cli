import { access, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { checkbox, editor, input, select } from '@inquirer/prompts';
import { parseDocument } from 'yaml';
import { fetchConsoleMemberUserInfo } from '../api/me.js';
import { fetchImpressionCategoryList } from '../api/mini-apps.js';
import type { CdpCookie } from '../cdp.js';
import {
  APP_NAME_REGEX,
  countCodepointsExcludingSpaces,
  isTitleCaseWord,
  isValidEmail,
  MANIFEST_LIMITS,
  TITLE_EN_REGEX,
  TITLE_KO_REGEX,
} from '../config/app-manifest.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { readSession } from '../session.js';
import { emitFailureFromError, emitJson, emitNotAuthenticated } from './_shared.js';
import { type InitAnswers, renderInitYaml } from './app-init-template.js';

// `runAppInit` is the testable seam for `aitcc app init`. The citty
// wrapper in `app.ts` is a thin shim. Tests cover the render + yaml
// round-trip, the conflict path (existing manifest), and the non-TTY
// refusal — the inquirer prompts themselves are not mocked because the
// scope of the test is the file-IO contract, not the keystroke flow.
//
// --json contract:
//
//   The command itself does not support interactive prompts under
//   `--json` or in non-TTY environments. Both refuse with:
//     { ok: false, reason: 'interactive-required', message }   exit 2
//
//   On success the user only ever sees the human-readable next-steps
//   block on stderr. There is no machine-readable success shape — by
//   design, this command is a one-shot bootstrap meant for humans.

export interface AppInitArgs {
  readonly cwd?: string;
  readonly force: boolean;
  readonly json: boolean;
}

export async function runAppInit(args: AppInitArgs): Promise<void> {
  const cwd = args.cwd ?? process.cwd();

  if (args.json) {
    emitInteractiveRequired(true);
    return exitAfterFlush(ExitCode.Usage);
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    emitInteractiveRequired(false);
    return exitAfterFlush(ExitCode.Usage);
  }

  const yamlPath = resolvePath(cwd, 'aitcc.yaml');
  const jsonPath = resolvePath(cwd, 'aitcc.json');
  if (!args.force) {
    const existing = (await fileExists(yamlPath))
      ? yamlPath
      : (await fileExists(jsonPath))
        ? jsonPath
        : null;
    if (existing) {
      process.stderr.write(
        `A project file already exists at ${existing}. Pass --force to overwrite.\n`,
      );
      return exitAfterFlush(ExitCode.Usage);
    }
  }

  const session = await readSession();
  if (!session) {
    emitNotAuthenticated(false);
    return exitAfterFlush(ExitCode.NotAuthenticated);
  }

  let workspaceId: number;
  let categoryIds: number[];
  try {
    workspaceId = await pickWorkspace(session.cookies);
    categoryIds = await pickCategories(session.cookies);
  } catch (err) {
    if (isPromptCancelled(err)) {
      process.stderr.write('Aborted.\n');
      return exitAfterFlush(ExitCode.Usage);
    }
    return emitFailureFromError(false, err);
  }

  let answers: InitAnswers;
  try {
    const titleKo = await input({
      message: 'App title (Korean):',
      validate: validateTitleKo,
    });
    const titleEn = await input({
      message: 'App title (English):',
      validate: validateTitleEn,
    });
    const appName = await input({
      message: 'App slug (kebab-case):',
      validate: validateAppName,
    });
    const csEmail = await input({
      message: 'Customer-support email:',
      validate: validateEmail,
    });
    const subtitle = await input({
      message: `Subtitle (≤${MANIFEST_LIMITS.subtitleMaxChars} chars):`,
      validate: validateSubtitle,
    });
    const description = await editor({
      message: 'Long description (opens $EDITOR):',
      validate: validateDescription,
    });
    answers = {
      workspaceId,
      titleKo,
      titleEn,
      appName,
      csEmail,
      subtitle,
      description,
      categoryIds,
    };
  } catch (err) {
    if (isPromptCancelled(err)) {
      process.stderr.write('Aborted.\n');
      return exitAfterFlush(ExitCode.Usage);
    }
    throw err;
  }

  const rendered = renderInitYaml(answers);

  // Round-trip the rendered yaml so a template bug surfaces here, not
  // in the user's next `aitcc app register` run. Failure here is a CLI
  // bug (renderer fault), not user input.
  const doc = parseDocument(rendered);
  if (doc.errors.length > 0) {
    const detail = doc.errors[0]?.message ?? 'unknown parse error';
    process.stderr.write(`internal error: rendered yaml failed to parse (${detail})\n`);
    return exitAfterFlush(ExitCode.Generic);
  }

  // Create the assets dir before writing the manifest so a permission /
  // disk error can't leave a `aitcc.yaml` pointing at a directory we
  // failed to provision. Both calls are wrapped so an FS failure surfaces
  // as a clean error + exit code rather than an unhandled rejection.
  try {
    const assetsDir = resolvePath(cwd, 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(yamlPath, rendered, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failed to write project files: ${detail}\n`);
    return exitAfterFlush(ExitCode.Generic);
  }

  emitNextSteps(yamlPath);
  return exitAfterFlush(ExitCode.Ok);
}

function emitInteractiveRequired(json: boolean): void {
  const message = 'aitcc app init requires an interactive TTY.';
  if (json) {
    emitJson({ ok: false, reason: 'interactive-required', message });
  } else {
    process.stderr.write(`${message}\n`);
  }
}

function emitNextSteps(yamlPath: string): void {
  const rel = isAbsolute(yamlPath) ? `./${relativeFromCwd(yamlPath)}` : yamlPath;
  process.stderr.write(`✓ wrote ${rel}\n`);
  process.stderr.write('Next steps:\n');
  process.stderr.write(
    '  1. Drop these images into ./assets/ (dimensions enforced on register):\n',
  );
  process.stderr.write('       logo.png              600×600\n');
  process.stderr.write('       thumbnail.png         1932×828\n');
  process.stderr.write('       screenshot-1.png      636×1048\n');
  process.stderr.write('       screenshot-2.png      636×1048\n');
  process.stderr.write('       screenshot-3.png      636×1048\n');
  process.stderr.write('  2. Run `aitcc app register` to create the mini-app.\n');
  process.stderr.write('     (`miniAppId` is written back into ./aitcc.yaml automatically.)\n');
}

function relativeFromCwd(absPath: string): string {
  const cwd = process.cwd();
  if (absPath.startsWith(`${cwd}/`)) return absPath.slice(cwd.length + 1);
  return absPath;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Inquirer raises `ExitPromptError` (Ctrl+C / SIGINT) so the caller can
// distinguish a deliberate abort from a programming error. We sniff
// `err.name` rather than `instanceof` because the class lives in
// `@inquirer/core`, which we don't depend on directly — this avoids
// pulling in a transitive package as a top-level dep just for an
// `instanceof` check the inquirer docs already recommend by name.
function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

async function pickWorkspace(cookies: readonly CdpCookie[]): Promise<number> {
  const info = await fetchConsoleMemberUserInfo(cookies);
  const workspaces = info.workspaces;
  if (workspaces.length === 0) {
    process.stderr.write(
      'Your account has no workspaces. Create one in the Apps in Toss console first.\n',
    );
    await exitAfterFlush(ExitCode.Usage);
  }
  if (workspaces.length === 1) {
    const only = workspaces[0];
    if (!only) throw new Error('unreachable: workspaces[0] missing');
    process.stderr.write(
      `Using workspace ${only.workspaceId} (${only.workspaceName}) — only one available.\n`,
    );
    return only.workspaceId;
  }
  const choice = await select<number>({
    message: 'Workspace:',
    choices: workspaces.map((w) => ({
      name: `${w.workspaceId}  ${w.workspaceName}`,
      value: w.workspaceId,
    })),
  });
  return choice;
}

async function pickCategories(cookies: readonly CdpCookie[]): Promise<number[]> {
  const tree = await fetchImpressionCategoryList(cookies);
  // Build a flat list of selectable leaves (sub-categories where present,
  // otherwise top-level categories). Group headings are interleaved as
  // disabled items so the user can still see the hierarchy.
  type Choice = {
    name: string;
    value: number;
    disabled?: string | true;
  };
  const choices: Choice[] = [];
  for (const group of tree) {
    if (!group.categoryGroup.isSelectable) continue;
    choices.push({
      name: `── ${group.categoryGroup.name} ──`,
      value: -group.categoryGroup.id,
      disabled: ' ',
    });
    for (const cat of group.categoryList) {
      if (cat.subCategoryList.length > 0) {
        for (const sub of cat.subCategoryList) {
          if (!sub.isSelectable) continue;
          choices.push({
            name: `  ${cat.name} › ${sub.name}  [${sub.id}]`,
            value: sub.id,
          });
        }
      } else if (cat.isSelectable) {
        choices.push({
          name: `  ${cat.name}  [${cat.id}]`,
          value: cat.id,
        });
      }
    }
  }
  if (choices.every((c) => c.disabled !== undefined)) {
    throw new Error('No selectable categories returned by the server.');
  }
  const picked = await checkbox<number>({
    message: 'Categories (space to toggle, enter to confirm; pick at least one):',
    choices,
    validate: (entries) => (entries.length === 0 ? 'pick at least one category' : true),
    pageSize: 20,
  });
  return picked;
}

// --- Prompt validators ---
//
// inquirer expects `true` for "valid" or a string error message otherwise.
// Each validator mirrors the corresponding manifest-level rule so the
// values produced by `init` will always pass `register`'s validator —
// see `app-manifest.ts` for the source-of-truth constants/regexes.

function validateTitleKo(raw: string): true | string {
  if (raw.trim().length === 0) return 'titleKo is required';
  if (!TITLE_KO_REGEX.test(raw)) {
    return 'only Korean/English letters, digits, spaces, and ":·?" are allowed';
  }
  const len = countCodepointsExcludingSpaces(raw);
  if (len > MANIFEST_LIMITS.titleKoMaxCodepoints) {
    return `must be ≤ ${MANIFEST_LIMITS.titleKoMaxCodepoints} characters excluding spaces (got ${len})`;
  }
  return true;
}

function validateTitleEn(raw: string): true | string {
  if (raw.trim().length === 0) return 'titleEn is required';
  if (!TITLE_EN_REGEX.test(raw)) {
    return 'only English letters, digits, spaces, and ":·?" are allowed';
  }
  const len = countCodepointsExcludingSpaces(raw);
  if (len > MANIFEST_LIMITS.titleEnMaxCodepoints) {
    return `must be ≤ ${MANIFEST_LIMITS.titleEnMaxCodepoints} characters excluding spaces (got ${len})`;
  }
  for (const word of raw.split(' ')) {
    if (word.length === 0) continue;
    if (!isTitleCaseWord(word)) {
      return `word "${word}" must be title-case (first letter upper, rest lower)`;
    }
  }
  return true;
}

function validateAppName(raw: string): true | string {
  if (!APP_NAME_REGEX.test(raw)) {
    return 'must be kebab-case starting with a lowercase letter (a-z, 0-9, hyphen)';
  }
  return true;
}

function validateEmail(raw: string): true | string {
  if (!isValidEmail(raw)) return 'not a valid email address';
  return true;
}

function validateSubtitle(raw: string): true | string {
  if (raw.trim().length === 0) return 'subtitle is required';
  if (raw.length > MANIFEST_LIMITS.subtitleMaxChars) {
    return `must be ≤ ${MANIFEST_LIMITS.subtitleMaxChars} characters (got ${raw.length})`;
  }
  return true;
}

function validateDescription(raw: string): true | string {
  if (raw.trim().length === 0) return 'description is required';
  const len = [...raw].length;
  if (len > MANIFEST_LIMITS.descriptionMaxCodepoints) {
    return `must be ≤ ${MANIFEST_LIMITS.descriptionMaxCodepoints} characters (got ${len})`;
  }
  return true;
}
