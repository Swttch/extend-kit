#!/usr/bin/env node

import { getCredentials, getAccessToken } from '../battery/auth/index.js';
import { ClaudeCodeClient } from '../battery/api/index.js';
import { oauthCommand } from './oauth.js';
import { sttCommand } from './stt.js';
import { getAccountCredentials } from './account-credentials.js';
import { CcbError } from '../battery/errors.js';
import { applySettingsEnv } from '../settings-env.js';

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

/**
 * `--env NAME=VALUE`, repeatable: a variable the caller is forcing for this run.
 *
 * An assignment written in front of a command (`FOO=bar ccb ...`) cannot be told apart from
 * one exported in a startup file — both arrive as plain entries in the environment, carrying
 * no record of how they got there. So a caller who means "use THIS one, whatever the settings
 * files say" has no way to say it through the environment, and says it through this flag
 * instead. Values given here outrank the settings files; nothing outranks them.
 */
function forcedEnv(): Array<[string, string]> {
  return args
    .filter(arg => arg.startsWith('--env='))
    .map(arg => arg.slice('--env='.length))
    .map((assignment): [string, string] | null => {
      const eq = assignment.indexOf('=');
      // A value may itself contain "=" (a proxy URL with a query string does), so only the
      // FIRST separator splits. A name may not be empty; a value may.
      if (eq <= 0) return null;
      return [assignment.slice(0, eq), assignment.slice(eq + 1)];
    })
    .filter((pair): pair is [string, string] => pair !== null);
}

async function createClient(): Promise<ClaudeCodeClient> {
  const credentials = accountFile ? await getAccountCredentials(accountFile) : await getCredentials();
  const token = getAccessToken(credentials);
  return new ClaudeCodeClient(token);
}

async function run(): Promise<void> {
  // Before anything reads the environment. `claude` applies its settings files' `env` block
  // to itself this way, and every read below — the proxy, the OAuth token, the config dir —
  // has to see the same environment `claude` would see on this machine.
  //
  // The project whose settings apply is the directory this process was started in, which is
  // how the spawning plugin names one: it sets the child's working directory.
  //
  // Forced values go in FIRST and are then skipped by the settings pass, rather than being
  // applied on top afterwards. The order is what makes `--env=CLAUDE_CONFIG_DIR=...` work:
  // that variable decides WHICH settings files get read, so a value arriving after the read
  // would be too late to have any effect on it.
  const forced = forcedEnv();
  for (const [name, value] of forced) process.env[name] = value;
  await applySettingsEnv(process.cwd(), new Set(forced.map(([name]) => name)));

  const [module, ...subcommand] = command;

  if (flags.has('--capabilities')) {
    // A caller checks this before using a command: the plugin has to know
    // whether the kit on this machine is new enough to stream dictation, since
    // the only alternative it once had (importing the module) is gone.
    console.log(JSON.stringify({ capabilities: ['oauth.usage.account-file', 'stt.stream'] }));
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
  stt              Transcribe raw PCM audio from stdin (see below)
  stt --check      Report whether this machine can dictate

Options:
  --env=NAME=VALUE       Force one environment variable for this run (repeatable).
                         Outranks the env block of Claude Code's settings files.
  --account-file=<path>  Read usage for a CCG saved-account snapshot (no account switch)
  --language=<code>      BCP-47 language for stt (default: en)
  --keyterms=<a,b,c>     Extra vocabulary to bias stt toward
  --interims             Also emit interim stt guesses
  --capabilities   Output supported CLI capabilities as JSON
  --json           Output as JSON
  -h, --help       Show help
  -v, --version    Show version

stt reads raw PCM on stdin (16-bit LE, 16 kHz, mono) and writes one JSON
object per line to stdout. Any other audio format transcribes to silence.

  ffmpeg -f avfoundation -i ':0' -ar 16000 -ac 1 -f s16le - | ccb stt`);
    return;
  }

  // Handled before createClient(): stt reads the login inside the stream, and
  // building a client up front would turn "not signed in" into a crash before
  // `stt --check` could answer it calmly.
  if (module === 'stt') {
    const code = await sttCommand(subcommand, args, flags, jsonOutput);
    if (code !== 0) process.exit(code);
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
