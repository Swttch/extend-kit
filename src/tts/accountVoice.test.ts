import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseVoiceOptions, pickVoiceSettings } from './accountVoice.js';

describe('pickVoiceSettings', () => {
  it('reads the three fields when they are of the right kind', () => {
    assert.deepEqual(pickVoiceSettings({ voice_preference: 'ko-balgeun', voice_speed: 1.2, voice_language_code: 'ko' }), {
      voice: 'ko-balgeun', speed: 1.2, language: 'ko',
    });
  });

  it('drops what is missing, empty, or out of range', () => {
    assert.deepEqual(pickVoiceSettings({ voice_preference: ' ', voice_speed: 3, voice_language_code: null }), {
      voice: undefined, speed: undefined, language: undefined,
    });
  });
});

describe('chooseVoiceOptions', () => {
  it('uses the account voice and speed when the caller asked for nothing', () => {
    assert.deepEqual(chooseVoiceOptions({}, { voice: 'buttery', speed: 1.2 }), { voice: 'buttery', speed: 1.2, language: undefined });
  });

  it('lets what the caller named win', () => {
    assert.deepEqual(chooseVoiceOptions({ voice: 'airy', speed: 0.8 }, { voice: 'buttery', speed: 1.2 }), { voice: 'airy', speed: 0.8, language: undefined });
  });

  it('keeps a Korean voice for Korean text', () => {
    assert.equal(chooseVoiceOptions({ language: 'ko' }, { voice: 'ko-balgeun' }).voice, 'ko-balgeun');
  });

  it('leaves a Korean voice out for text in another language', () => {
    assert.equal(chooseVoiceOptions({ language: 'ja' }, { voice: 'ko-balgeun' }).voice, undefined);
  });

  it('uses the detected language over the account language', () => {
    assert.equal(chooseVoiceOptions({ language: 'ko' }, { language: 'en' }).language, 'ko');
    assert.equal(chooseVoiceOptions({}, { language: 'en' }).language, 'en');
  });
});
