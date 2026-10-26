#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applySettingsEnv } from '../settings-env.js';
import { OPERATIONS, operationCapabilities } from './operations.js';
import { describeError, runOperation, type ApiResult } from './run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION: string = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version;

const args = process.argv.slice(2);

/** `--name value` or `--name=value`, for every name that is not one of this command's own flags. */
const OWN_FLAGS = new Set(['json', 'yes', 'list', 'capabilities', 'help', 'version', 'env']);

function parseOptions(rest: string[]): { positionals: string[]; values: Record<string, string>; flags: Set<string>; env: Array<[string, string]> } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const env: Array<[string, string]> = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-h') { flags.add('help'); continue; }
    if (arg === '-v') { flags.add('version'); continue; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === 'env' && eq !== -1) {
      const assignment = arg.slice(eq + 1);
      const at = assignment.indexOf('=');
      if (at > 0) env.push([assignment.slice(0, at), assignment.slice(at + 1)]);
      continue;
    }
    if (OWN_FLAGS.has(name)) { flags.add(name); continue; }
    if (eq !== -1) { values[name] = arg.slice(eq + 1); continue; }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) { values[name] = ''; continue; }
    values[name] = next;
    i++;
  }
  return { positionals, values, flags, env };
}

function print(result: ApiResult): void {
  console.log(JSON.stringify(result));
}

const HELP = `swttch-ext v${VERSION} — calls to services Swttch uses, from @swttch/extend-kit

Usage: swttch-ext api <service> <call> [--param value ...] [--yes] [--json]

  swttch-ext api --list                 List the calls this version can make
  swttch-ext --capabilities             List what this version can do, as JSON
  swttch-ext api frame retitle --slug <id> --title "New name"
  swttch-ext api frame pin --slug <id>
  swttch-ext api frame delete --slug <id> --yes

Every call prints one JSON object: {"ok":true,"data":...} or {"ok":false,"error":{...}}.
A call that cannot be undone refuses to run without --yes.`;

async function main(): Promise<number> {
  const { positionals, values, flags, env } = parseOptions(args);

  if (flags.has('version')) { console.log(VERSION); return 0; }
  if (flags.has('capabilities')) {
    console.log(JSON.stringify({ capabilities: operationCapabilities() }));
    return 0;
  }
  if (flags.has('help') || positionals.length === 0) { console.log(HELP); return 0; }

  const [command, service, call] = positionals;
  if (command !== 'api') { console.error(`Unknown command: ${command}\n\n${HELP}`); return 1; }

  if (flags.has('list')) {
    console.log(JSON.stringify({
      calls: OPERATIONS.map(({ service: s, name, method, path, params, capability, destructive, about }) => ({
        service: s, name, method, path, capability, destructive, about,
        params: params.map(({ name: n, required, about: a }) => ({ name: n, required, about: a })),
      })),
    }));
    return 0;
  }
  if (!service || !call) { print({ ok: false, error: { code: 'invalid_argument', message: 'Say which call: swttch-ext api <service> <call>.' } }); return 2; }

  // The same environment `claude` would see, as `ccb` sets it up: the proxy and the login both depend on it.
  for (const [name, value] of env) process.env[name] = value;
  await applySettingsEnv(process.cwd(), new Set(env.map(([name]) => name)));

  const result = await runOperation(service, call, values, { yes: flags.has('yes'), version: VERSION });
  print(result);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => { if (code !== 0) process.exit(code); },
  (err) => { print(describeError(err)); process.exit(1); },
);
