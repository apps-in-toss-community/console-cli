import { defineCommand } from 'citty';
import { fetchNoticeCategories, fetchNoticePost, fetchNotices } from '../api/ipd-thor.js';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import { emitFailureFromError, emitJson, requireSession } from './_shared.js';

// --json contract (consumed by agent-plugin):
//
//   notices ls [--page N] [--size N] [--search STR]:
//     { ok: true, page, pageSize, count, hasNext, notices: [...] }   exit 0
//
//   notices show <id>:
//     { ok: true, id, notice: {...} }                                 exit 0
//     { ok: false, reason: 'invalid-id', message }                    exit 2
//
//   notices categories:
//     { ok: true, categories: [...] }                                 exit 0
//
// Notices live on a separate service (ipd-thor) from the rest of the
// console API. There's no per-user workspace scoping — all notices come
// from Toss's shared workspace 129. Session cookies captured at login
// include the `.toss.im` suffix so they're sent automatically to the
// ipd-thor host.

function parsePositiveInt(raw: string, field: string): { value: number } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { error: `--${field} must be a non-negative integer (got ${JSON.stringify(raw)})` };
  }
  return { value: n };
}

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List notices (공지사항) from Apps in Toss.',
  },
  args: {
    page: { type: 'string', description: 'Page number (0-indexed).', default: '0' },
    size: { type: 'string', description: 'Page size.', default: '20' },
    search: { type: 'string', description: 'Filter by title substring (case-insensitive).' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const session = await requireSession(args.json);
    if (!session) return;
    const pageResult = parsePositiveInt(args.page, 'page');
    if ('error' in pageResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'page', message: pageResult.error });
      } else {
        process.stderr.write(`notices ls: ${pageResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const sizeResult = parsePositiveInt(args.size, 'size');
    if ('error' in sizeResult) {
      if (args.json) {
        emitJson({ ok: false, reason: 'invalid-config', field: 'size', message: sizeResult.error });
      } else {
        process.stderr.write(`notices ls: ${sizeResult.error}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    if (sizeResult.value === 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-config',
          field: 'size',
          message: '--size must be at least 1',
        });
      } else {
        process.stderr.write('notices ls: --size must be at least 1\n');
      }
      return exitAfterFlush(ExitCode.Usage);
    }

    try {
      const result = await fetchNotices(
        {
          page: pageResult.value,
          size: sizeResult.value,
          ...(typeof args.search === 'string' && args.search.length > 0
            ? { titleContains: args.search }
            : {}),
        },
        session.cookies,
      );

      if (args.json) {
        emitJson({
          ok: true,
          page: result.page,
          pageSize: result.pageSize,
          count: result.count,
          hasNext: result.next !== null,
          notices: result.results,
        });
        return exitAfterFlush(ExitCode.Ok);
      }

      process.stdout.write(
        `Notices: page ${result.page}, ${result.results.length}/${result.count} shown\n`,
      );
      if (result.results.length === 0) {
        process.stdout.write('No notices on this page.\n');
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const n of result.results) {
        const id = typeof n.id === 'string' || typeof n.id === 'number' ? n.id : '-';
        const category = typeof n.category === 'string' ? n.category : '-';
        const title = typeof n.title === 'string' ? n.title : '';
        const publishedTime = typeof n.publishedTime === 'string' ? n.publishedTime : '';
        process.stdout.write(`${id}\t${publishedTime}\t[${category}]\t${title}\n`);
      }
      if (result.next !== null) {
        process.stdout.write(`(more: --page ${result.page + 1})\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show a single notice post by ID.',
  },
  args: {
    id: { type: 'positional', description: 'Notice post ID.', required: true },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const postId = Number(args.id);
    if (!Number.isFinite(postId) || !Number.isInteger(postId) || postId <= 0) {
      if (args.json) {
        emitJson({
          ok: false,
          reason: 'invalid-id',
          message: `notice id must be a positive integer (got ${JSON.stringify(args.id)})`,
        });
      } else {
        process.stderr.write(`notices show: invalid id ${JSON.stringify(args.id)}\n`);
      }
      return exitAfterFlush(ExitCode.Usage);
    }
    const session = await requireSession(args.json);
    if (!session) return;
    try {
      const notice = await fetchNoticePost(postId, session.cookies);
      if (args.json) {
        emitJson({ ok: true, id: postId, notice });
        return exitAfterFlush(ExitCode.Ok);
      }
      const title = typeof notice.title === 'string' ? notice.title : '';
      const subtitle = typeof notice.subtitle === 'string' ? notice.subtitle : '';
      const category = typeof notice.category === 'string' ? notice.category : '';
      const publishedTime = typeof notice.publishedTime === 'string' ? notice.publishedTime : '';
      const body =
        typeof notice.fullDescription === 'string'
          ? notice.fullDescription
          : typeof notice.shortDescription === 'string'
            ? notice.shortDescription
            : '';
      process.stdout.write(`# ${title}\n`);
      if (subtitle) process.stdout.write(`${subtitle}\n`);
      process.stdout.write(`\n[${category}] ${publishedTime}\n\n`);
      process.stdout.write(body);
      if (!body.endsWith('\n')) process.stdout.write('\n');
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

const categoriesCommand = defineCommand({
  meta: {
    name: 'categories',
    description: 'List notice categories and their post counts.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const session = await requireSession(args.json);
    if (!session) return;
    try {
      const categories = await fetchNoticeCategories(session.cookies);
      if (args.json) {
        emitJson({ ok: true, categories });
        return exitAfterFlush(ExitCode.Ok);
      }
      for (const c of categories) {
        const id = typeof c.id === 'string' || typeof c.id === 'number' ? c.id : '-';
        const name = typeof c.name === 'string' ? c.name : '-';
        const postCount = typeof c.postCount === 'number' ? c.postCount : 0;
        process.stdout.write(`${id}\t${postCount}\t${name}\n`);
      }
      return exitAfterFlush(ExitCode.Ok);
    } catch (err) {
      return emitFailureFromError(args.json, err);
    }
  },
});

export const noticesCommand = defineCommand({
  meta: {
    name: 'notices',
    description: 'Read Apps in Toss notices (공지사항). Shared across all users.',
  },
  subCommands: {
    ls: lsCommand,
    show: showCommand,
    categories: categoriesCommand,
  },
});
