/**
 * The `env` block of Claude Code's settings files, applied the way `claude` applies it.
 *
 * `claude` reads its own settings files and puts their `env` block into the environment
 * before it talks to anything. Nothing else on the machine does that — a variable written
 * only into settings.json never becomes a real environment variable — so a tool that reads
 * `process.env` alone sees a different configuration than `claude` does on the same machine.
 *
 * That difference is not hypothetical. It broke the usage panel twice: once for a proxy set
 * only in settings.json, and again for the lower-case spelling of the same variable. Both
 * times the fix was to name one more variable somewhere. This module reads the block whole
 * instead, so the next variable needs no fix at all.
 *
 * The rules below were measured against `claude` 2.1.261 by writing six shapes of value into
 * a project's settings.json and reading back what its child process received:
 *
 *   "PLAIN":  "value"            → value               (passed through)
 *   "BRACE":  "pre-${HOME}-post" → pre-${HOME}-post    (NOT expanded)
 *   "FALL":   "${UNSET:-fb}"     → ${UNSET:-fb}        (NOT expanded)
 *   "EMPTY":  ""                 → empty, still set    (not a deletion)
 *   "NUMBER": 1234               → "1234"              (stringified)
 *   "BOOL":   true               → "true"              (stringified)
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code keeps its settings and credentials.
 *
 * Read from the environment, never from a settings file — see {@link EXCLUDED_NAMES}.
 */
export function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
}

/**
 * Names this module refuses to take from a settings file.
 *
 * `CLAUDE_CONFIG_DIR` decides WHERE the settings file is. Reading it back out of that file
 * would mean the file's location depends on a value only readable after the file is found,
 * so the value is honoured from the environment only. The plugin that spawns this CLI settles
 * it the same way: it keeps that one variable in its own settings and passes it in.
 */
const EXCLUDED_NAMES = new Set(['CLAUDE_CONFIG_DIR']);

/**
 * The settings files, in the order `claude` layers them — later wins.
 *
 * The project pair is dropped when no project directory is known, which is what a bare
 * `ccb` in a directory with no `.claude` folder amounts to anyway.
 */
function settingsFiles(projectDir: string | undefined): string[] {
  const configDir = claudeConfigDir();
  const files = [
    join(configDir, 'settings.json'),
    join(configDir, 'settings.local.json'),
  ];
  if (projectDir) {
    files.push(
      join(projectDir, '.claude', 'settings.json'),
      join(projectDir, '.claude', 'settings.local.json'),
    );
  }
  return files;
}

/**
 * One value as an environment variable, or null when it cannot be one.
 *
 * Numbers and booleans are stringified because `claude` passes them on stringified. An empty
 * string is a value, not a removal — also measured.
 *
 * Objects, arrays and null are skipped. `claude`'s handling of those was NOT measured, and
 * the alternatives are worse than skipping: `String({})` is the literal "[object Object]",
 * which is a value no one meant to set.
 */
function asEnvValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** The `env` object of one settings file, or an empty object when there is not one. */
async function readEnvBlock(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    // A settings file that does not exist is the normal case, not a failure.
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as { env?: unknown };
    const env = parsed.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    return env as Record<string, unknown>;
  } catch {
    // A settings file we cannot parse is the user's to fix. Failing the whole command over
    // it would take away the usage panel and dictation for a stray comma.
    return {};
  }
}

/**
 * Every variable the settings files set, merged global-to-project.
 *
 * Returned rather than applied so a caller can see the block without changing the process,
 * which is how the tests read it.
 */
export async function readSettingsEnv(projectDir?: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const filePath of settingsFiles(projectDir)) {
    const block = await readEnvBlock(filePath);
    for (const [name, value] of Object.entries(block)) {
      if (EXCLUDED_NAMES.has(name)) continue;
      const asValue = asEnvValue(value);
      if (asValue !== null) merged[name] = asValue;
    }
  }

  return merged;
}

/**
 * Put the settings files' `env` block into this process's environment.
 *
 * The settings value wins over whatever this process inherited, because that is what `claude`
 * does: with the same name exported in the shell and written into settings.json, the value its
 * child received was the settings one. Matching that is the whole point — the user edits that
 * file for `claude`, so `claude` is the behaviour to agree with.
 *
 * A value forced on the command line is the one thing that outranks this, and it is read from
 * the flag that carries it rather than from here: an assignment written in front of a command
 * is indistinguishable from an inherited variable by the time it arrives, so a flag is the only
 * way a caller can say "this one, whatever the files say".
 */
export async function applySettingsEnv(projectDir: string = process.cwd()): Promise<void> {
  const settingsEnv = await readSettingsEnv(projectDir);
  for (const [name, value] of Object.entries(settingsEnv)) {
    process.env[name] = value;
  }
}
