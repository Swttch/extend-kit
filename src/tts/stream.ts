import WebSocket from 'ws';
import { getCredentials, getAccessToken, isTokenExpired } from '../battery/auth/index.js';
import { CcbError } from '../battery/errors.js';
import { proxyAgentFor } from '../proxy.js';

const TEXT_TO_SPEECH_URL = 'wss://api.anthropic.com/api/ws/text_to_speech/text_stream';

/** What the service sends back: 16-bit little-endian PCM, 16 kHz, mono. */
export const SPEECH_AUDIO_FORMAT = { encoding: 'pcm_16000', sampleRate: 16000, channels: 1 } as const;

/** The speed range the service accepts, as the official clients clamp it. */
export const SPEECH_SPEED_RANGE = { min: 0.7, max: 1.5 } as const;

/** Longest text one `text_chunk` carries; longer text is cut at sentence ends. */
const MAX_CHUNK_CHARS = 800;

/** The service drops idle sockets; this is well inside its window. */
const KEEPALIVE_INTERVAL_MS = 4000;

/** How long to wait for the first audio before giving up on a socket that opened but says nothing. */
const FIRST_AUDIO_TIMEOUT_MS = 25000;

export interface TextToSpeechOptions {
  /** A voice name the service knows; the service's own default when omitted. */
  voice?: string;
  /** Playback speed, kept within {@link SPEECH_SPEED_RANGE}. */
  speed?: number;
  /** A BCP-47 language hint such as "ko". */
  language?: string;
}

export interface TextToSpeechHandlers {
  /** A piece of audio, in {@link SPEECH_AUDIO_FORMAT}. Arrives in order. */
  onAudio: (chunk: Buffer) => void;
  /** The service said everything it was given. Fired once, after the last audio. */
  onDone: () => void;
  /** The reading failed. `fatal` means retrying will not help (the account is refused). */
  onError: (message: string, info?: { fatal?: boolean }) => void;
}

export interface TextToSpeechStream {
  /** Stop now. No handler fires after this. */
  cancel: () => void;
}

/**
 * Cut `text` into pieces of at most {@link MAX_CHUNK_CHARS}, at sentence ends and blank lines where it can.
 * The service reads each piece as it arrives, so the first audio comes before the last piece is sent.
 */
export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.length <= MAX_CHUNK_CHARS) return [trimmed];
  const sentences = trimmed.split(/(?<=[.!?。！？])\s+|\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  // A single sentence longer than the limit is cut where it stands: the service takes no more than this at once.
  return chunks.flatMap((chunk) => {
    if (chunk.length <= MAX_CHUNK_CHARS) return [chunk];
    const parts: string[] = [];
    for (let at = 0; at < chunk.length; at += MAX_CHUNK_CHARS) parts.push(chunk.slice(at, at + MAX_CHUNK_CHARS));
    return parts;
  });
}

function clampSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  return Math.min(SPEECH_SPEED_RANGE.max, Math.max(SPEECH_SPEED_RANGE.min, speed));
}

/**
 * Read `text` aloud by streaming it to the same service the Claude desktop app's "Read aloud" uses.
 *
 * Lives in this package, outside the plugin bundle, for the reason dictation does: asking for speech sends the
 * account's OAuth token, and a JetBrains plugin may not handle credentials. The plugin runs `swttch-ext tts` and
 * only ever sees audio coming back.
 *
 * The endpoint is undocumented. It is called the way the desktop app calls it, and every message is treated as
 * untrusted: an unknown message type is ignored rather than raised, so a type added server-side breaks nothing.
 */
export async function openTextToSpeechStream(
  text: string,
  handlers: TextToSpeechHandlers,
  options: TextToSpeechOptions = {},
  token?: string,
): Promise<TextToSpeechStream> {
  const accessToken = token ?? getAccessToken(await getCredentials());
  const chunks = splitForSpeech(text);

  const speed = clampSpeed(options.speed);
  const query = new URLSearchParams({
    output_format: SPEECH_AUDIO_FORMAT.encoding,
    ...(options.voice ? { voice: options.voice } : {}),
    ...(speed === undefined ? {} : { tts_speed: speed.toFixed(2) }),
    client_platform: 'claude_code_swttch',
    ...(options.language ? { language: options.language } : {}),
  });
  const url = `${TEXT_TO_SPEECH_URL}?${query.toString()}`;

  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-app': 'swttch',
      'anthropic-client-platform': 'claude_code_swttch',
    },
    // The upgrade request needs the same proxy the other calls use.
    agent: proxyAgentFor(url),
  });

  let finished = false;
  let audioSeen = false;
  let keepalive: NodeJS.Timeout | null = null;
  let firstAudioTimer: NodeJS.Timeout | null = null;

  const stopTimers = (): void => {
    if (keepalive) clearInterval(keepalive);
    if (firstAudioTimer) clearTimeout(firstAudioTimer);
    keepalive = null;
    firstAudioTimer = null;
  };
  const finish = (): boolean => {
    if (finished) return false;
    finished = true;
    stopTimers();
    return true;
  };
  const fail = (message: string, info?: { fatal?: boolean }): void => {
    if (!finish()) return;
    try { socket.close(); } catch { /* already gone */ }
    handlers.onError(message, info);
  };

  if (chunks.length === 0) {
    finished = true;
    handlers.onDone();
    return { cancel: () => undefined };
  }

  socket.on('open', () => {
    for (const piece of chunks) socket.send(JSON.stringify({ type: 'text_chunk', text: piece }));
    socket.send(JSON.stringify({ type: 'close_stream' }));
    keepalive = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keep_alive' }));
    }, KEEPALIVE_INTERVAL_MS);
    firstAudioTimer = setTimeout(() => {
      if (!audioSeen) fail('The speech service did not answer in time.');
    }, FIRST_AUDIO_TIMEOUT_MS);
  });

  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (finished) return;
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      audioSeen = true;
      if (firstAudioTimer) { clearTimeout(firstAudioTimer); firstAudioTimer = null; }
      handlers.onAudio(chunk);
      return;
    }
    let message: { type?: string; message?: string; description?: string };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      return;
    }
    if (message.type === 'SpeechComplete') {
      if (!finish()) return;
      try { socket.close(); } catch { /* already gone */ }
      handlers.onDone();
    } else if (message.type === 'SpeechError' || message.type === 'error') {
      fail(message.message ?? message.description ?? 'The speech service reported an error.');
    }
    // Any other type (SpeechStalled and whatever comes next) says nothing we have to act on.
  });

  socket.on('unexpected-response', (_request, response) => {
    // A handshake the service refused: 401 and 403 are the account's problem, and retrying will not help.
    const status = response.statusCode ?? 0;
    fail(`The speech service refused the connection (${status}).`, { fatal: status >= 400 && status < 500 });
  });

  socket.on('error', (err: Error) => {
    if (finished) return;
    fail(`WebSocket error: ${err.message}`);
  });

  socket.on('close', () => {
    // Closed with neither a completion nor an error: whatever audio came is all there will be.
    if (finish()) {
      if (audioSeen) handlers.onDone();
      else handlers.onError('The speech service closed without audio.');
    }
  });

  return {
    cancel(): void {
      if (finished) return;
      finished = true;
      stopTimers();
      try { socket.close(); } catch { /* already gone */ }
    },
  };
}

/** Whether this machine can ask for speech: a Claude Code login that has not expired. */
export async function isTextToSpeechAvailable(): Promise<boolean> {
  try {
    const credentials = await getCredentials();
    getAccessToken(credentials);
    return !isTokenExpired(credentials);
  } catch (err) {
    if (err instanceof CcbError) return false;
    throw err;
  }
}
