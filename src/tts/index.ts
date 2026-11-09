/**
 * Text-to-speech: reading a reply aloud with the service the Claude desktop app uses.
 *
 * Outside the plugin bundle for the same reason as dictation: it sends the account's OAuth token.
 */
export { openTextToSpeechStream, isTextToSpeechAvailable, splitForSpeech, SPEECH_AUDIO_FORMAT, SPEECH_SPEED_RANGE } from './stream.js';
export type { TextToSpeechOptions, TextToSpeechHandlers, TextToSpeechStream } from './stream.js';
