import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  acceptConsent,
  CURRENT_POLICY_VERSION,
  deleteMyData,
  denyConsent,
  getOrCreateAnonId,
  readConsentState,
  resolveEffectiveConsent,
  TELEMETRY_ENDPOINT,
  telemetryFilePath,
} from '../telemetry/index.js';

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current telemetry consent state and anon_id.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const consent = await resolveEffectiveConsent();
    const anonId = consent === 'granted' ? await getOrCreateAnonId() : null;
    const filePath = telemetryFilePath();

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          consent,
          policyVersion: CURRENT_POLICY_VERSION,
          endpoint: TELEMETRY_ENDPOINT,
          ...(anonId ? { anonId } : {}),
          filePath,
        })}\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    }

    process.stdout.write(`Telemetry: ${consent}\n`);
    process.stdout.write(`Policy version: ${CURRENT_POLICY_VERSION}\n`);
    process.stdout.write(`Endpoint: ${TELEMETRY_ENDPOINT}\n`);
    if (anonId) process.stdout.write(`Anon ID: ${anonId}\n`);
    process.stdout.write(`State file: ${filePath}\n`);
    return exitAfterFlush(ExitCode.Ok);
  },
});

const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description: 'Enable anonymous usage telemetry (opt-in).',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    await acceptConsent();
    const anonId = await getOrCreateAnonId();
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, consent: 'granted', anonId })}\n`);
    } else {
      process.stdout.write('Telemetry enabled. Thank you!\n');
      process.stdout.write(`Anon ID: ${anonId}\n`);
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});

const disableCommand = defineCommand({
  meta: {
    name: 'disable',
    description: 'Disable anonymous usage telemetry.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    await denyConsent();
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, consent: 'denied' })}\n`);
    } else {
      process.stdout.write('Telemetry disabled.\n');
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});

const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete your telemetry data from the server and rotate the local anon_id.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const beforeConsent = await readConsentState();
    const ok = await deleteMyData(TELEMETRY_ENDPOINT);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok,
          ...(ok ? {} : { reason: beforeConsent === 'undecided' ? 'no-data' : 'server-error' }),
        })}\n`,
      );
    } else {
      if (ok) {
        process.stdout.write(
          'Deletion request sent. Your data has been removed and a new anon ID assigned.\n',
        );
      } else if (beforeConsent === 'undecided') {
        process.stdout.write('No telemetry data to delete (telemetry was never enabled).\n');
      } else {
        process.stderr.write(
          'Deletion request failed. Please try again or contact the maintainers.\n',
        );
      }
    }
    return exitAfterFlush(
      ok || beforeConsent === 'undecided' ? ExitCode.Ok : ExitCode.NetworkError,
    );
  },
});

export const telemetryCommand = defineCommand({
  meta: {
    name: 'telemetry',
    description: 'Manage anonymous usage telemetry (opt-in).',
  },
  subCommands: {
    status: statusCommand,
    enable: enableCommand,
    disable: disableCommand,
    delete: deleteCommand,
  },
});
