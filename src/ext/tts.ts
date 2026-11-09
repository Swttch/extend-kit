import { openTextToSpeechStream, readAccountVoiceSettings, chooseVoiceOptions } from '../tts/index.js';

/** The name `--capabilities` lists for this command, so the plugin can tell a kit that has it from one that does not. */
export const TTS_CAPABILITY = 'tts';

/**
 * `swttch-ext tts` — reading text aloud as a process, not as a library.
 *
 * ── stdin ──  the text to read, UTF-8, until it closes.
 * ── stdout ── raw audio and nothing else: 16-bit little-endian PCM, 16 kHz, mono, as it arrives.
 * ── stderr ── on failure, one JSON line: {"ok":false,"error":{"code","message","fatal"}}.
 * ── exit ───  0 when the service said everything, 1 when it failed. Killing the process stops the reading.
 *
 * What the caller does not name comes from the Claude account's own voice settings (the voice, speed and language
 * chosen in the desktop app), so a voice picked there is the voice heard here.
 *
 * A terminal user can drive it by hand (macOS):
 *
 *   echo "Hello" | swttch-ext tts | play -t raw -r 16000 -e signed -b 16 -c 1 -
 *
 * The plugin cannot ask the service itself: that sends the account's OAuth token, and a JetBrains plugin may not
 * handle credentials. It runs this command and relays the audio.
 */
export async function runTextToSpeech(options: { language?: string; speed?: string; voice?: string }): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');

  const askedSpeed = options.speed === undefined || options.speed === '' ? undefined : Number(options.speed);
  const chosen = chooseVoiceOptions(
    { voice: options.voice || undefined, speed: askedSpeed, language: options.language || undefined },
    await readAccountVoiceSettings(),
  );

  return new Promise<number>((resolve) => {
    const stopOnPipeClosed = (): void => {
      // The reader went away (the plugin stopped listening): there is nobody to read to.
      stream?.then((s) => s.cancel()).finally(() => resolve(0));
    };
    process.stdout.on('error', stopOnPipeClosed);

    const stream = openTextToSpeechStream(
      text,
      {
        onAudio: (audio) => {
          process.stdout.write(audio);
        },
        onDone: () => resolve(0),
        onError: (message, info) => {
          process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'tts_failed', message, fatal: info?.fatal ?? false } })}\n`);
          resolve(1);
        },
      },
      chosen,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'not_logged_in', message, fatal: true } })}\n`);
      resolve(1);
      return undefined as never;
    });
  });
}

/**
 * `swttch-ext tts --settings` — the voice, speed and language the Claude account has chosen, as one JSON object:
 * `{"ok":true,"data":{"voice":"buttery","speed":1.2,"language":null}}`. A field the account has not set is null.
 * Lets a caller show what reading aloud will use when it is not told otherwise.
 */
export async function printVoiceSettings(): Promise<number> {
  const settings = await readAccountVoiceSettings();
  process.stdout.write(`${JSON.stringify({ ok: true, data: { voice: settings.voice ?? null, speed: settings.speed ?? null, language: settings.language ?? null } })}\n`);
  return 0;
}
