#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { upgradeCommand } from './commands/upgrade.js';
import { whoamiCommand } from './commands/whoami.js';
import { VERSION } from './version.js';

const main = defineCommand({
  meta: {
    name: 'ait-console',
    version: VERSION,
    description:
      'Community CLI for the Apps in Toss developer console (unofficial; not affiliated with Toss).',
  },
  subCommands: {
    whoami: whoamiCommand,
    login: loginCommand,
    logout: logoutCommand,
    upgrade: upgradeCommand,
  },
});

runMain(main);
