#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { appCommand } from './commands/app.js';
import { authCommand } from './commands/auth.js';
import { completionCommand } from './commands/completion.js';
import { keysCommand } from './commands/keys.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { meCommand } from './commands/me.js';
import { membersCommand } from './commands/members.js';
import { noticesCommand } from './commands/notices.js';
import { telemetryCommand } from './commands/telemetry.js';
import { cleanupStaleUpgradeArtifacts, upgradeCommand } from './commands/upgrade.js';
import { whoamiCommand } from './commands/whoami.js';
import { workspaceCommand } from './commands/workspace.js';
import { trackInvocation } from './telemetry/index.js';
import { VERSION } from './version.js';

const main = defineCommand({
  meta: {
    name: 'aitcc',
    version: VERSION,
    description:
      'aitcc — Apps in Toss Community Console CLI. Unofficial, not affiliated with Toss.',
  },
  subCommands: {
    whoami: whoamiCommand,
    login: loginCommand,
    logout: logoutCommand,
    auth: authCommand,
    upgrade: upgradeCommand,
    workspace: workspaceCommand,
    app: appCommand,
    members: membersCommand,
    keys: keysCommand,
    notices: noticesCommand,
    me: meCommand,
    telemetry: telemetryCommand,
    completion: completionCommand,
  },
});

cleanupStaleUpgradeArtifacts().catch(() => {
  // best-effort; failure must not affect command execution.
});

// Resolve the top-level subcommand name for telemetry tracking.
// argv[2] is the first token after `aitcc`; skip flags (starting with '-').
const _telemetryCmd = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? '(none)';
// Fire-and-forget: never blocks command execution.
void trackInvocation(_telemetryCmd);

runMain(main);
