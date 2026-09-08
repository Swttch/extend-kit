#!/usr/bin/env node

import { getCredentials, getAccessToken } from '../battery/auth/index.js';
import { ClaudeCodeClient } from '../battery/api/index.js';
import { oauthCommand } from './oauth.js';
import { getAccountCredentials } from './account-credentials.js';
import { CcbError } from '../battery/errors.js';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
const VERSION: string = pkg.version;

const args = process.argv.slice(2);
const command = args.filter((a: string) => !a.startsWith('-'));
const flags = new Set(args.filter((a: string) => a.startsWith('-')));
const jsonOutput = flags.has('--json');
const accountFile = args.find(arg => arg.startsWith('--account-file='))?.slice('--account-file='.length);

async function createClient(): Promise<ClaudeCodeClient> {
  const credentials = accountFile ? await getAccountCredentials(accountFile) : await getCredentials();
  const token = getAccessToken(credentials);
  return new ClaudeCodeClient(token);
}

async function run(): Promise<void> {
  const [module, ...subcommand] = command;

  if (flags.has('--capabilities')) {
    console.log(JSON.stringify({ capabilities: ['oauth.usage.account-file'] }));
    return;
  }
  if (args.some(arg => arg.startsWith('--account-file')) && (!accountFile || module !== 'oauth' || subcommand[0] !== 'usage')) {
    throw new CcbError('Use oauth usage --account-file=<snapshot path>.', 'invalid_argument');
  }

  if (flags.has('-v') || flags.has('--version')) {
    console.log(VERSION);
    return;
  }

  if (!module || flags.has('-h') || flags.has('--help')) {
    console.log(`ccb v${VERSION} — Claude Code account CLI, from @swttch/extend-kit

Usage: ccb <command> [options]

Commands:
  oauth usage      Show usage limits
  oauth profile    Show account profile

Options:
  --account-file=<path>  Read usage for a CCG saved-account snapshot (no account switch)
  --capabilities   Output supported CLI capabilities as JSON
  --json           Output as JSON
  -h, --help       Show help
  -v, --version    Show version`);
    return;
  }

  const client = await createClient();

  switch (module) {
    case 'oauth':
      await oauthCommand(client, subcommand, jsonOutput);
      break;
    default:
      console.error(`Unknown module: ${module}`);
      process.exit(1);
  }
}

run().catch((err) => {
  if (jsonOutput) {
    if (err instanceof CcbError) {
      console.error(JSON.stringify(err.toJSON(), null, 2));
    } else {
      console.error(JSON.stringify({
        error: {
          code: 'unknown_error',
          message: err instanceof Error ? err.message : String(err),
        },
      }, null, 2));
    }
  } else {
    if (err instanceof CcbError) {
      console.error(`Error: ${err.message}`);
      if (err.hint) {
        console.error(`Hint: ${err.hint}`);
      }
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
  process.exit(1);
});
