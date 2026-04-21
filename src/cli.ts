#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { upgradeCommand } from './commands/upgrade.js';
import { whoamiCommand } from './commands/whoami.js';
import { workspaceCommand } from './commands/workspace.js';
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
    upgrade: upgradeCommand,
    workspace: workspaceCommand,
  },
});

runMain(main);
