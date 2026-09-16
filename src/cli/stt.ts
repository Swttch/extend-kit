import { openSpeechToTextStream, isSpeechToTextAvailable } from '../stt/index.js';
import { CcbError } from '../battery/errors.js';

/**
 * `ccb stt` — dictation as a process, not as a library.
 *
 * The plugin cannot call {@link openSpeechToTextStream} directly. Transcribing
 * reads the machine's Claude Code login, and importing this package into the
 * backend would put that read inside the plugin's own process — the exact thing
 * that moved these tools out to a separate package. Spawning instead keeps the
 * token on this side of the process boundary: the caller writes audio and reads
 * text, and never holds a credential.
 *
 * So the wire format here is the public contract, the same way `oauth usage
 * --json` is. A terminal user can drive it by hand:
 *
 *   ffmpeg -f avfoundation -i ':0' -ar 16000 -ac 1 -f s16le - | ccb stt
 *
 * ── stdin ──  raw PCM: 16-bit little-endian, 16 kHz, mono. Nothing else is
 *              accepted, and a wrong format transcribes to silence rather than
 *              failing (see CLAUDE.md), so the caller must convert first.
 * ── stdout ── one JSON object per line, flushed as it happens.
 * ── exit ───  0 when the speaker finished, 1 when the stream failed to open.
 */

/** Line-oriented events written to stdout. */
export enum SttEventType {
  /** The socket is open and audio is being transcribed. */
  Open = 'open',
  /** Text arrived. `isFinal` false will be replaced by a later line. */
  Transcript = 'transcript',
  /** The stream failed. `fatal` means retrying will not help. */
  Error = 'error',
}

interface SttEvent {
  type: SttEventType;
  text?: string;
  isFinal?: boolean;
  message?: string;
  fatal?: boolean;
}

/**
 * Write one event as a single line.
 *
 * `process.stdout.write` rather than `console.log` because the caller parses
 * this by newline: console.log is the same thing here, but going through the
 * stream directly makes it explicit that one call must produce exactly one line
 * and that nothing else may ever be printed to stdout by this command.
 */
function emit(event: SttEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Split a `--keyterms=a,b,c` value, dropping empties and surrounding spaces. */
function parseKeyterms(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * `ccb stt --check --json` — can this machine dictate at all?
 *
 * Separate from opening a stream because the answer drives different UI: a
 * machine with no Claude Code login should be told to sign in, not shown a
 * socket error. Always exits 0; "no" is an answer rather than a failure.
 */
async function checkAvailability(jsonOutput: boolean): Promise<void> {
  const available = await isSpeechToTextAvailable().catch(() => false);
  if (jsonOutput) {
    console.log(JSON.stringify({ available }));
    return;
  }
  console.log(available ? 'available' : 'unavailable (no Claude Code login on this machine)');
}

/**
 * Open the stream and pump stdin into it until the caller stops writing.
 *
 * Audio written before the socket finishes opening is not lost: the stream
 * buffers pre-open chunks itself, which matters more here than in-process
 * because a pipe delivers the caller's first chunk almost immediately.
 */
async function runStream(options: {
  language?: string;
  extraKeyterms: string[];
  typedInterims: boolean;
}): Promise<number> {
  if (process.stdin.isTTY) {
    console.error(
      'ccb stt reads raw PCM audio (16-bit LE, 16 kHz, mono) on stdin; pipe audio into it.',
    );
    return 1;
  }

  let stream;
  try {
    stream = await openSpeechToTextStream(
      {
        onTranscript: (text, isFinal) => emit({ type: SttEventType.Transcript, text, isFinal }),
        onError: (message, info) =>
          emit({ type: SttEventType.Error, message, fatal: info?.fatal ?? false }),
        onOpen: () => emit({ type: SttEventType.Open }),
      },
      {
        language: options.language,
        extraKeyterms: options.extraKeyterms,
        typedInterims: options.typedInterims,
      },
    );
  } catch (err) {
    // Failing to open is reported on the same channel as everything else, so a
    // caller parsing stdout never has to also watch stderr to learn why
    // dictation did not start. A rejected login lands here.
    emit({
      type: SttEventType.Error,
      message: err instanceof Error ? err.message : String(err),
      fatal: true,
    });
    return 1;
  }

  return new Promise<number>((resolve) => {
    let finished = false;

    /**
     * Close once, then exit.
     *
     * `close()` waits for the service to flush the last words, so the trailing
     * transcript is emitted before this resolves. Called from both stdin end
     * and a termination signal, hence the guard.
     */
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stream
        .close()
        .then(() => resolve(0))
        .catch(() => resolve(0));
    };

    process.stdin.on('data', (chunk: Buffer) => {
      stream.sendAudio(new Uint8Array(chunk));
    });
    process.stdin.on('end', finish);
    // A parent that kills us instead of closing stdin still gets the last words.
    process.on('SIGTERM', finish);
    process.on('SIGINT', finish);
  });
}

/**
 * Entry point for the `stt` module of the CLI.
 *
 * Takes no {@link ClaudeCodeClient}: unlike `oauth`, this command reads the
 * login itself inside the stream, and building a client up front would turn
 * "not signed in" into a crash before `--check` could answer it.
 */
export async function sttCommand(
  subcommand: string[],
  args: string[],
  flags: Set<string>,
  jsonOutput: boolean,
): Promise<number> {
  if (flags.has('--check') || subcommand[0] === 'check') {
    await checkAvailability(jsonOutput);
    return 0;
  }

  if (subcommand.length > 0) {
    throw new CcbError(`Unknown stt subcommand: ${subcommand[0]}`, 'invalid_argument');
  }

  const language = args.find((arg) => arg.startsWith('--language='))?.slice('--language='.length);
  const keyterms = args.find((arg) => arg.startsWith('--keyterms='))?.slice('--keyterms='.length);

  return runStream({
    language,
    extraKeyterms: parseKeyterms(keyterms),
    typedInterims: flags.has('--interims'),
  });
}
