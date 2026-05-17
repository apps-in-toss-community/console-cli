import { defineCommand } from 'citty';
import { ExitCode } from '../exit.js';
import { exitAfterFlush } from '../flush.js';
import {
  acceptConsent,
  CURRENT_POLICY_VERSION,
  deleteMyData,
  denyConsent,
  getOrCreateAnonId,
  getTier0LastSent,
  isTier0OptedOut,
  readConsentState,
  resolveEffectiveConsent,
  setTier0OptOut,
  TELEMETRY_ENDPOINT,
  telemetryFilePath,
} from '../telemetry/index.js';

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current telemetry status for both Tier 0 and Tier 1.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    const [tier1Consent, tier0OptOut, tier0LastSent, anonId] = await Promise.all([
      resolveEffectiveConsent(),
      isTier0OptedOut(),
      getTier0LastSent(),
      resolveEffectiveConsent().then((c) => (c === 'granted' ? getOrCreateAnonId() : null)),
    ]);
    const filePath = telemetryFilePath();

    const tier0Status = tier0OptOut ? 'off (opted out)' : 'on';
    const tier0Display = tier0LastSent
      ? `${tier0Status}  (last sent: ${tier0LastSent})`
      : tier0Status;

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          tier0: {
            status: tier0OptOut ? 'opted-out' : 'on',
            lastSent: tier0LastSent ?? null,
          },
          tier1: {
            consent: tier1Consent,
            policyVersion: CURRENT_POLICY_VERSION,
            ...(anonId ? { anonId } : {}),
          },
          endpoint: TELEMETRY_ENDPOINT,
          filePath,
        })}\n`,
      );
      return exitAfterFlush(ExitCode.Ok);
    }

    process.stdout.write('Telemetry status\n');
    process.stdout.write(`  Tier 0 (anonymous daily ping): ${tier0Display}\n`);
    process.stdout.write(
      `  Tier 1 (opt-in events):        ${tier1Consent}  (policyVersion: ${CURRENT_POLICY_VERSION})\n`,
    );
    process.stdout.write(`\nEndpoint:   ${TELEMETRY_ENDPOINT}\n`);
    if (anonId) process.stdout.write(`Anon ID:    ${anonId}\n`);
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

const tier0OffCommand = defineCommand({
  meta: {
    name: 'tier0-off',
    description: 'Permanently opt out of the Tier 0 anonymous daily ping.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    await setTier0OptOut(true);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, tier0: { status: 'opted-out' } })}\n`);
    } else {
      process.stdout.write('Tier 0 anonymous ping disabled. No daily pings will be sent.\n');
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});

const tier0OnCommand = defineCommand({
  meta: {
    name: 'tier0-on',
    description: 'Re-enable the Tier 0 anonymous daily ping after a previous tier0-off.',
  },
  args: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.', default: false },
  },
  async run({ args }) {
    await setTier0OptOut(false);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, tier0: { status: 'on' } })}\n`);
    } else {
      process.stdout.write('Tier 0 anonymous ping re-enabled.\n');
    }
    return exitAfterFlush(ExitCode.Ok);
  },
});

export const telemetryCommand = defineCommand({
  meta: {
    name: 'telemetry',
    description: 'Manage anonymous usage telemetry.',
  },
  subCommands: {
    status: statusCommand,
    enable: enableCommand,
    disable: disableCommand,
    delete: deleteCommand,
    'tier0-off': tier0OffCommand,
    'tier0-on': tier0OnCommand,
  },
});
