import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSettingsEnv, applySettingsEnv, claudeConfigDir } from './settings-env.js';

/**
 * The value shapes below mirror what `claude` was measured to do with the same settings file.
 * Each assertion states one of those measurements, so a change that drifts away from `claude`
 * fails here rather than in a user's corporate network.
 */
describe('readSettingsEnv', () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'ccb-settings-env-config-'));
    projectDir = await mkdtemp(path.join(os.tmpdir(), 'ccb-settings-env-project-'));
    await mkdir(path.join(projectDir, '.claude'), { recursive: true });
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const writeGlobal = (name: string, env: unknown) =>
    writeFile(path.join(configDir, name), JSON.stringify({ env }));
  const writeProject = (name: string, env: unknown) =>
    writeFile(path.join(projectDir, '.claude', name), JSON.stringify({ env }));

  it('returns every name in the block, not a chosen few', async () => {
    await writeGlobal('settings.json', {
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-settings',
      SOMETHING_WE_HAVE_NEVER_HEARD_OF: 'still forwarded',
    });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['HTTPS_PROXY'], 'http://proxy:3128');
    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat01-from-settings');
    assert.equal(env['SOMETHING_WE_HAVE_NEVER_HEARD_OF'], 'still forwarded');
  });

  it('stringifies numbers and booleans, and keeps an empty string as a value', async () => {
    await writeGlobal('settings.json', { A_NUMBER: 1234, A_BOOL: true, AN_EMPTY: '' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['A_NUMBER'], '1234');
    assert.equal(env['A_BOOL'], 'true');
    assert.equal(env['AN_EMPTY'], '');
    assert.ok('AN_EMPTY' in env, 'an empty string is a value, not a removal');
  });

  it('leaves ${NAME} untouched, because claude does', async () => {
    await writeGlobal('settings.json', { A_BRACE: 'pre-${HOME}-post', A_FALLBACK: '${UNSET:-fb}' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['A_BRACE'], 'pre-${HOME}-post');
    assert.equal(env['A_FALLBACK'], '${UNSET:-fb}');
  });

  it('layers the four files global-to-project, keeping names the later files do not mention', async () => {
    await writeGlobal('settings.json', { ONLY_GLOBAL: 'g', OVERRIDDEN: 'from-global' });
    await writeGlobal('settings.local.json', { OVERRIDDEN: 'from-global-local' });
    await writeProject('settings.json', { OVERRIDDEN: 'from-project' });
    await writeProject('settings.local.json', { OVERRIDDEN: 'from-project-local' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['OVERRIDDEN'], 'from-project-local');
    assert.equal(env['ONLY_GLOBAL'], 'g', 'a later file must not drop names it does not mention');
  });

  it('never takes CLAUDE_CONFIG_DIR from a settings file', async () => {
    await writeGlobal('settings.json', { CLAUDE_CONFIG_DIR: '/somewhere/else', OTHER: 'kept' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined,
      'the file that would supply it is found using it, so reading it back is circular');
    assert.equal(env['OTHER'], 'kept');
    assert.equal(claudeConfigDir(), configDir, 'the environment stays the only source');
  });

  it('ignores a project whose settings files are absent', async () => {
    await writeGlobal('settings.json', { FROM_GLOBAL: 'g' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['FROM_GLOBAL'], 'g');
  });

  it('survives a settings file that is not valid JSON', async () => {
    await writeFile(path.join(configDir, 'settings.json'), '{ "env": { "A": "b", }');
    await writeGlobal('settings.local.json', { STILL_READ: 'yes' });

    const env = await readSettingsEnv(projectDir);

    assert.equal(env['STILL_READ'], 'yes', 'one broken file must not take the rest down');
  });
});

describe('applySettingsEnv', () => {
  let configDir: string;
  let projectDir: string;
  let originalConfigDir: string | undefined;
  const TOUCHED = 'CCB_SETTINGS_ENV_TEST_VAR';

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'ccb-apply-env-config-'));
    projectDir = await mkdtemp(path.join(os.tmpdir(), 'ccb-apply-env-project-'));
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    delete process.env[TOUCHED];
    await rm(configDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('lets the settings value win over what the process inherited', async () => {
    process.env[TOUCHED] = 'inherited';
    await writeFile(path.join(configDir, 'settings.json'),
      JSON.stringify({ env: { [TOUCHED]: 'from-settings' } }));

    await applySettingsEnv(projectDir);

    assert.equal(process.env[TOUCHED], 'from-settings',
      'claude was measured to override an exported variable with the settings block');
  });

  it('leaves variables the settings files do not mention alone', async () => {
    process.env[TOUCHED] = 'inherited';
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ env: { OTHER: 'x' } }));

    await applySettingsEnv(projectDir);

    assert.equal(process.env[TOUCHED], 'inherited');
    delete process.env['OTHER'];
  });
});
