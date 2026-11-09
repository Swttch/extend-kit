import { getCredentials, getAccessToken } from '../battery/auth/index.js';
import { getJson } from '../battery/api/http.js';
import { SPEECH_SPEED_RANGE } from './stream.js';

/** What the Claude account says about how replies are read aloud (the voice settings of the desktop app and claude.ai). */
export interface AccountVoiceSettings {
  /** A voice id such as "buttery" or "ko-balgeun". */
  voice?: string;
  /** Playback speed. */
  speed?: number;
  /** The language the account reads in, such as "ko". */
  language?: string;
}

const ACCOUNT_SETTINGS_URL = 'https://api.anthropic.com/api/oauth/account/settings';

/**
 * The voice, speed and language chosen in the Claude desktop app, as the account stores them.
 *
 * Those three are account settings, not per-device ones: choosing a "Bright" Korean voice in the desktop app writes
 * `voice_preference` to the account, so reading the account gives the same voice here without a second setting to
 * keep in step. Nothing is written back.
 *
 * Answers an empty object when the account cannot be read for any reason: reading aloud then uses the service's own
 * defaults rather than failing because a preference was out of reach.
 */
export async function readAccountVoiceSettings(token?: string): Promise<AccountVoiceSettings> {
  try {
    const accessToken = token ?? getAccessToken(await getCredentials());
    const response = await getJson<Record<string, unknown>>(
      ACCOUNT_SETTINGS_URL,
      { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'x-app': 'swttch' },
      { deadlineMs: 8000 },
    );
    if (!response.ok || typeof response.body !== 'object' || response.body === null) return {};
    return pickVoiceSettings(response.body);
  } catch {
    return {};
  }
}

/** The three voice fields of an account settings document, each only when it is of the right kind. */
export function pickVoiceSettings(settings: Record<string, unknown>): AccountVoiceSettings {
  const voice = typeof settings.voice_preference === 'string' && settings.voice_preference.trim() !== '' ? settings.voice_preference.trim() : undefined;
  const speed =
    typeof settings.voice_speed === 'number' && settings.voice_speed >= SPEECH_SPEED_RANGE.min && settings.voice_speed <= SPEECH_SPEED_RANGE.max
      ? settings.voice_speed
      : undefined;
  const language = typeof settings.voice_language_code === 'string' && settings.voice_language_code.trim() !== '' ? settings.voice_language_code.trim() : undefined;
  return { voice, speed, language };
}

/** "ko-balgeun" is read for Korean text; "buttery", which names no language, for any. */
function voiceLanguage(voice: string): string | undefined {
  const at = voice.indexOf('-');
  return at > 0 ? voice.slice(0, at).toLowerCase() : undefined;
}

/**
 * What to ask the service for, given what the caller said and what the account chose.
 *
 * What the caller named wins. Otherwise the account's speed applies. The account's voice applies only when it can
 * read the text: a voice made for one language (`ko-balgeun`) is left out for text in another, since the service
 * would read that text in a voice that cannot pronounce it. The language hint is the caller's detection of the
 * text first, and the account's language only when the caller could not tell.
 */
export function chooseVoiceOptions(
  asked: { voice?: string; speed?: number; language?: string },
  account: AccountVoiceSettings,
): { voice?: string; speed?: number; language?: string } {
  const language = asked.language ?? account.language;
  const textLanguage = (asked.language ?? account.language)?.split('-')[0].toLowerCase();
  let voice = asked.voice;
  if (voice === undefined && account.voice !== undefined) {
    const needs = voiceLanguage(account.voice);
    if (needs === undefined || textLanguage === undefined || needs === textLanguage) voice = account.voice;
  }
  return { voice, speed: asked.speed ?? account.speed, language };
}
