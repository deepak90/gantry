/**
 * Remy on a call: one job per room (`project-<projectId>`).
 *
 * - Ears: one transcribing session per person, so every turn has a speaker, and a hum gate on each
 *   person's microphone that decides barge-in.
 * - Mouth: one session that only speaks. Each line is voiced whole by one request from the moment it is handed over,
 *   in her ElevenLabs voice or else OpenAI's (elevenlabs.ts), and plays behind a short jitter buffer (jitter-buffer.ts).
 *   OpenAI's takes are rendered whole first and made once more when they drag or fall into fry (pace.ts); fillers are
 *   checked takes made once.
 * - Brain: not here. Each finished turn goes to every tab as `heard`; the host's tab answers with
 *   the `remy.say` RPC, and the end of each line comes back as `said` (see messages.ts).
 * - Lines: only the host's (whoever has been on the call longest, host.ts) are taken. On the hosted worker each is
 *   counted against the call's limits before a sound is made of it (line-limits.ts), and with the service's secret
 *   only lines it signed are said (line-proof.ts).
 *
 * Remy never speaks on her own except one short filler after a line meant for her, when the answer
 * is slow, and the call's limits (limits.ts, hosted calls): a wrap-up line before the call's time runs out,
 * and a goodbye when nobody has spoken for a while. People talking to each other get no answer and no filler.
 * A line is meant for her when it says her name, follows up on her answer, or comes from the only person on the call
 * (addressing.ts). On a call with a time limit, her `remy.ends_at` attribute says when it ends, for every tab's clock.
 */
import { randomUUID } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { defineAgent, voice, type JobContext, type VAD } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { OpenAI } from 'openai';
import {
  AudioStream,
  ParticipantKind,
  RoomEvent,
  RpcError,
  TrackKind,
  TrackSource,
  type AudioFrame,
  type LocalParticipant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type RpcInvocationData,
} from '@livekit/rtc-node';
import { Addressing, aloneOnCall, endsWithQuestion, firstName, mayContinue } from './addressing.ts';
import { afterAnswer, type Waiting } from './waiting.ts';
import * as config from './config.ts';
import { chooseSpeech } from './elevenlabs.ts';
import { FillerScheduler } from './filler.ts';
import { prepareFiller, toFrames, type FillerMaker } from './filler-audio.ts';
import { hostOf } from './host.ts';
import { HopFeeder, HumGate, type HumGateEvent } from './hum-gate.ts';
import { bufferedLine } from './jitter-buffer.ts';
import { leaveCall } from './leaving.ts';
import { callEndOf, CallLimits, limitsFromEnv, type CallLimitsConfig } from './limits.ts';
import { judgeLine } from './line-gate.ts';
import { LineBudget, lineLimitsFromEnv } from './line-limits.ts';
import { errorText, logEvent } from './log.ts';
import {
  encodeMessage,
  ENDS_AT_ATTRIBUTE,
  LEAVING_ATTRIBUTE,
  parseSayRequest,
  projectOfRoom,
  SAY_METHOD,
  STATE_ATTRIBUTE,
  TOPIC,
  type RemyMessage,
  type RemyState,
  type SayResponse,
} from './messages.ts';
import { pacedFrames } from './pace.ts';
import { attachRoomIO, muteStartedSession } from './room-io.ts';
import { transcribeWords } from './speech-check.ts';
import { newSpeechStats, SAMPLE_RATE, StreamingLineTTS, type LineSpeech } from './tts.ts';
import { TurnAssembler, type Turn } from './turns.ts';

interface ProcessData {
  vad: VAD;
}

export default defineAgent<ProcessData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load({ minSilenceDuration: config.END_OF_SPEECH_MS });
  },
  entry: async (ctx) => {
    await new Call(ctx).start();
  },
});

/** A line in Remy's mouth: a `remy.say` answer, a filler, or a notice of her own (the call's limits). */
interface Line {
  id: string;
  kind: 'answer' | 'filler' | 'notice';
  text: string;
  /** The person this answers, when known. */
  to: string | null;
  handle: voice.SpeechHandle | null;
  acceptedAt: number;
  startedAt: number | null;
  done: boolean;
  interrupted: boolean;
  /** Who cut it off. */
  bargedBy: string | null;
  /** An answer's sound, on its way from the moment the line was taken. */
  audio: LineAudio | null;
  /** Called once the line is done: played, cut off, or never said. */
  onDone?: () => void;
}

interface LineAudio {
  stream: ReadableStream<AudioFrame>;
  /** Stops the synthesis (the line is done, cut off, or Remy is leaving). */
  abort: AbortController;
}

/** An addressed turn still waiting for its answer. */
interface Ear {
  identity: string;
  session: voice.AgentSession;
  turns: TurnAssembler;
  closing: boolean;
}

interface Gate {
  identity: string;
  trackSid: string;
  stream: AudioStream;
  closed: boolean;
}

const PERSON_KINDS = new Set([ParticipantKind.STANDARD, ParticipantKind.SIP, ParticipantKind.CONNECTOR]);
const isPerson = (p: RemoteParticipant) => PERSON_KINDS.has(p.kind);
const displayName = (p: RemoteParticipant) => p.attributes?.name?.trim() || p.name?.trim() || '';
/** When they joined, in ms by the call server's clock (what the tabs read too); 0 when it isn't known. */
const joinedAtOf = (p: RemoteParticipant): number => Number(p.info?.joinedAt ?? 0n);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const EAR_RESTARTS = 3;
const KEEP_DONE_LINES = 200;

function framesStream(frames: readonly AudioFrame[]): ReadableStream<AudioFrame> {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
}

/** Extra words for the transcriber: `{ "hints": [...] }` in the dispatch metadata, and REMY_STT_HINTS. */
function readHints(metadata: string): string[] {
  const words: string[] = [];
  try {
    const parsed: unknown = metadata ? JSON.parse(metadata) : {};
    const hints = parsed && typeof parsed === 'object' && 'hints' in parsed ? (parsed as { hints: unknown }).hints : null;
    if (Array.isArray(hints)) for (const hint of hints) if (typeof hint === 'string' && hint.trim()) words.push(hint.trim());
  } catch {
    // not JSON: no hints
  }
  for (const hint of (process.env.REMY_STT_HINTS ?? '').split(',')) if (hint.trim()) words.push(hint.trim());
  return [...new Set(words)].slice(0, 60);
}

class Call {
  #ctx: JobContext<ProcessData>;
  #room: Room;
  #vad: VAD;
  #speech: LineSpeech = chooseSpeech();
  /** The session's own TTS, for a line said without sound in hand; every line here brings its own. */
  #voice = new StreamingLineTTS(this.#speech);
  /** Whisper, which listens back to each filler take (speech-check.ts). */
  #whisper = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  #mouth: voice.AgentSession | null = null;
  #addressing = new Addressing();
  #filler: FillerScheduler;
  #ears = new Map<string, Ear>();
  #earRestarts = new Map<string, number>();
  #gates = new Map<string, Gate>();
  /** People whose hum gate hears sound right now. */
  #sounding = new Set<string>();
  #lines = new Map<string, Line>();
  /** Lines handed to the mouth and not done, in order: playback events arrive in this order. */
  #queue: Line[] = [];
  #audible: Line | null = null;
  #waiting: Waiting[] = [];
  #floorChain: Promise<void> = Promise.resolve();
  #fillerAudio = new Map<string, AudioFrame[]>();
  #hints: string[] = [];
  #state: RemyState | null = null;
  /** On her way out (or gone): she takes no more lines, and her sessions aren't started again. */
  #leaving = false;
  #closed = false;
  #emptyTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the host may hand her in this call (line-limits.ts). */
  #budget = new LineBudget(lineLimitsFromEnv(process.env, config.SAY_MAX_CHARS));
  #budgetSaid = false;
  /** The project this call is for, from the room's name: what the service's signatures name (line-proof.ts). */
  #project: string | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** How long she stays: the call's length and the silence she waits out (limits.ts; off unless hosted). */
  #limitsConfig: CallLimitsConfig;
  #limitsIgnored: string[];
  #limits: CallLimits;

  constructor(ctx: JobContext<ProcessData>) {
    this.#ctx = ctx;
    this.#room = ctx.room;
    this.#vad = ctx.proc.userData.vad;
    this.#filler = new FillerScheduler({
      busy: () => this.#remyAudible() || [...this.#lines.values()].some((line) => line.kind === 'answer' && !line.done),
      floorTaken: () => this.#floorTaken(),
      ready: (text) => this.#fillerAudio.has(text),
      play: (text) => this.#sayFiller(text),
    });
    const { limits, ignored } = limitsFromEnv();
    this.#limitsConfig = limits;
    this.#limitsIgnored = ignored;
    this.#limits = new CallLimits(limits, {
      busy: () => this.#floorTaken() || this.#remyAudible() || this.#answerOnItsWay(),
      wrapUp: () => {
        logEvent('limit_wrap_up', { maxS: limits.maxMs / 1000 });
        void this.#sayNotice(config.WRAP_UP_LINE);
      },
      timeUp: () => void this.#timeUp(),
      silence: () => void this.#quietGoodbye(),
    });
  }

  async start(): Promise<void> {
    const startedAt = Date.now();
    this.#hints = readHints(this.#ctx.job.metadata);
    await this.#ctx.connect();
    const room = this.#room;
    this.#project = projectOfRoom(room.name ?? '');
    logEvent('connected', { room: room.name, identity: this.#local()?.identity ?? null, msSinceJob: Date.now() - startedAt, hints: this.#hints.length });
    this.#ctx.addShutdownCallback(async () => this.#close('job shutdown'));

    await this.#startMouth();
    this.#local()?.registerRpcMethod(SAY_METHOD, (data) => this.#onSay(data));

    room.on(RoomEvent.ParticipantConnected, (p) => {
      logEvent('joined', { identity: p.identity, name: displayName(p), kind: p.kind, people: this.#people().length });
      if (!isPerson(p)) return;
      this.#cancelLeaving();
      void this.#startEar(p);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => this.#onLeft(p));
    room.on(RoomEvent.TrackSubscribed, (track, publication, p) => this.#startGate(track, publication, p));
    room.on(RoomEvent.TrackUnsubscribed, (_track, publication, p) => {
      if (this.#gates.get(p.identity)?.trackSid === publication.sid) this.#stopGate(p.identity);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      logEvent('disconnected', { reason });
      this.#ctx.shutdown(`room disconnected (${reason})`);
    });

    for (const p of room.remoteParticipants.values()) {
      if (!isPerson(p)) continue;
      void this.#startEar(p);
      for (const publication of p.trackPublications.values()) {
        if (publication.track) this.#startGate(publication.track, publication, p);
      }
    }
    this.#ticker = setInterval(() => this.#tick(), 1000);
    this.#publishState();
    logEvent('ready', { msSinceJob: Date.now() - startedAt, people: this.#people().map((p) => p.identity) });
    const siteEnd = callEndOf(this.#ctx.job.metadata);
    this.#limits.start(siteEnd);
    this.#publishEndsAt();
    const lines = this.#budget.config;
    logEvent('limits', {
      maxS: this.#limitsConfig.maxMs / 1000,
      ...(siteEnd !== null ? { siteEnd: new Date(siteEnd).toISOString() } : {}),
      silenceS: this.#limitsConfig.silenceMs / 1000,
      silenceEndsCall: this.#limitsConfig.silenceEndsCall,
      lineChars: lines.maxLineChars,
      ...(Number.isFinite(lines.maxCallChars) ? { callChars: lines.maxCallChars, linesPerMinute: lines.linesPerMinute, pending: lines.maxPending } : {}),
      signedLines: config.LINE_SECRET !== null,
      ...(config.LINE_SECRET !== null && !this.#project ? { unsignable: room.name } : {}),
      ...(this.#limitsIgnored.length ? { ignored: this.#limitsIgnored } : {}),
    });
    if (!this.#people().length) this.#leaveIfEmpty(config.NOBODY_CAME_LEAVE_MS, 'nobody came');
  }

  /**
   * When the call ends, as an attribute every tab reads, those that join later too: one clock for everyone on the call,
   * the worker's. Set once; a call without a time limit has none.
   */
  #publishEndsAt(): void {
    const endsAt = this.#limits.endsAt;
    if (endsAt === null) return;
    this.#local()
      ?.setAttributes({ [ENDS_AT_ATTRIBUTE]: String(endsAt) })
      .catch((error: unknown) => logEvent('ends_at_attribute_failed', { error: errorText(error) }));
    logEvent('ends_at', { at: new Date(endsAt).toISOString() });
  }

  // ---------------------------------------------------------------- mouth

  async #startMouth(): Promise<void> {
    const mouth = new voice.AgentSession({
      tts: this.#voice,
      vad: null,
      turnHandling: { turnDetection: 'manual' },
      userAwayTimeout: null,
      aecWarmupDuration: null,
    });
    mouth.on(voice.AgentSessionEventTypes.AgentStateChanged, () => this.#publishState());
    mouth.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      if (m.type === 'tts_metrics') logEvent('tts', { ttfbMs: m.ttfbMs, audioMs: m.audioDurationMs, chars: m.charactersCount });
    });
    mouth.on(voice.AgentSessionEventTypes.Error, (ev) => logEvent('mouth_error', { error: errorText((ev.error as { error?: unknown }).error ?? ev.error) }));
    mouth.on(voice.AgentSessionEventTypes.Close, (ev) => {
      logEvent('mouth_closed', { reason: ev.reason });
      if (!this.#leaving) this.#ctx.shutdown('mouth closed');
    });
    // The mouth starts first and builds its own RoomIO; the ears' sessions come after (room-io.ts).
    await mouth.start({
      agent: new voice.Agent({ instructions: 'Says the lines she is handed, word for word.' }),
      room: this.#room,
      record: false,
      inputOptions: { audioEnabled: false, textEnabled: false, closeOnDisconnect: false },
      outputOptions: { audioEnabled: true, transcriptionEnabled: true },
    });
    muteStartedSession(mouth);
    const output = mouth.output.audio;
    output?.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, (ev: voice.PlaybackStartedEvent) => this.#playbackStarted(ev.createdAt));
    output?.on(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, (ev: voice.PlaybackFinishedEvent) => this.#playbackFinished(ev));
    this.#mouth = mouth;
    logEvent('mouth_ready', { tts: this.#speech.model, provider: this.#speech.provider, voice: this.#speech.voiceLabel });
    void this.#prepareFillers();
  }

  /**
   * The fillers are made once and checked before use (filler-audio.ts), so one plays the moment it's due and never in
   * two beats; takes that passed are kept between calls. With `REMY_FILLERS=off` none are made.
   */
  async #prepareFillers(): Promise<void> {
    if (!config.FILLERS_ON) {
      logEvent('fillers_ready', { count: 0, off: true });
      return;
    }
    const speech = this.#speech;
    const maker: FillerMaker = {
      synthesize: (text) => speech.pcm(text),
      transcribe: (samples) => transcribeWords(this.#whisper, samples, SAMPLE_RATE),
    };
    await Promise.all(
      config.FILLERS.map(async (text) => {
        const take = await prepareFiller(text, maker, {
          cacheDir: config.FILLER_CACHE_DIR,
          voiceKey: speech.voiceKey,
          attempts: config.FILLER_ATTEMPTS,
          limits: { maxGapMs: config.FILLER_MAX_GAP_MS, minUnitsPerSec: config.FILLER_MIN_SYLLABLES_PER_SEC },
          onRefused: ({ attempt, verdict, error }) => logEvent('filler_refused', { text, attempt, reasons: verdict?.reasons ?? [], ...(error ? { error: errorText(error) } : {}) }),
        });
        if (!take) {
          logEvent('filler_audio_failed', { text, attempts: config.FILLER_ATTEMPTS });
          return;
        }
        this.#fillerAudio.set(text, toFrames(take.samples));
        logEvent('filler_audio', {
          text,
          cached: take.cached,
          attempts: take.attempts,
          ms: Math.round((take.samples.length / SAMPLE_RATE) * 1000),
          ...(take.verdict ? { longestSilenceMs: take.verdict.maxSilenceMs, syllablesPerSec: take.verdict.unitsPerSec } : {}),
        });
      }),
    );
    logEvent('fillers_ready', { count: this.#fillerAudio.size });
  }

  /**
   * Starts voicing an answer the moment it is handed over, while it waits for the floor or for the lines ahead. On a
   * voice that drifts (pace.ts), the line is rendered whole first and a dragging or creaky take is made again.
   */
  #synthesize(line: Line): LineAudio {
    const abort = new AbortController();
    const stats = newSpeechStats();
    const startedAt = Date.now();
    const source = config.PACE_CHECK_ON && this.#speech.checksPace
      ? pacedFrames(
          this.#speech,
          line.text,
          abort.signal,
          stats,
          { limitMs: config.PACE_LIMIT_MS, minSyllables: config.PACE_MIN_SYLLABLES, floorMs: config.PACE_FLOOR_MS, fry: config.FRY_CHECK_ON ? config.FRY : null },
          {
            onPace: (pace) =>
              logEvent('tts_pace', {
                id: line.id,
                chars: line.text.length,
                syllables: pace.syllables,
                limitMs: pace.limitMs,
                paceMs: pace.paceMs.map((ms) => Math.round(ms)),
                keptMs: pace.keptMs.map((ms) => Math.round(ms)),
                fry: pace.fry.map((f) =>
                  f
                    ? {
                        fry: f.fry,
                        medianHz: f.medianHz === null ? null : Math.round(f.medianHz),
                        thresholdHz: f.thresholdHz === null ? null : Math.round(f.thresholdHz),
                        lowPct: Math.round(f.lowShare * 1000) / 10,
                        runMs: f.longestRunMs,
                        runAtMs: f.runAtMs === null ? null : Math.round(f.runAtMs),
                        voiced: f.voiced,
                      }
                    : null,
                ),
                retried: pace.paceMs.length > 1 || pace.retryError !== undefined,
                reasons: pace.reasons,
                used: pace.used,
                waitMs: pace.waitMs,
                ...(pace.retryError !== undefined ? { retryError: errorText(pace.retryError) } : {}),
              }),
            onSkip: ({ syllables }) => logEvent('tts_pace', { id: line.id, chars: line.text.length, syllables, limitMs: config.PACE_LIMIT_MS, skipped: 'short' }),
          },
        )
      : this.#speech.frames(line.text, abort.signal, stats);
    const stream = bufferedLine(source, config.PREROLL_MS, abort, {
      onOpen: ({ heldMs, whole }) => logEvent('line_audio', { id: line.id, msSinceAccepted: Date.now() - line.acceptedAt, ttfbMs: stats.ttfbMs, heldMs: Math.round(heldMs), whole }),
      onEnd: ({ error }) =>
        logEvent('tts', {
          id: line.id,
          ttfbMs: stats.ttfbMs,
          audioMs: Math.round(stats.receivedMs),
          keptMs: Math.round(stats.keptMs),
          shortenedMs: Math.round(stats.shortenedMs),
          chars: line.text.length,
          attempts: stats.attempts,
          ms: Date.now() - startedAt,
          ...(abort.signal.aborted ? { stopped: true } : {}),
          ...(error ? { error: errorText(error) } : {}),
        }),
    });
    return { stream, abort };
  }

  /** Hands a line to the mouth with its sound: an answer's stream, or a filler's frames. */
  #speak(line: Line, frames?: readonly AudioFrame[]): void {
    const mouth = this.#mouth;
    const audio = line.audio?.stream ?? (frames?.length ? framesStream(frames) : null);
    if (!mouth || this.#leaving || !audio) {
      this.#lineDone(line);
      return;
    }
    const handle = mouth.say(line.text, { allowInterruptions: true, addToChatCtx: false, audio });
    line.handle = handle;
    this.#queue.push(line);
    logEvent('line_queued', { id: line.id, kind: line.kind, speechId: handle.id });
    handle
      .waitForPlayout()
      .catch(() => undefined)
      .finally(() => this.#lineDone(line));
  }

  #playbackStarted(at: number): void {
    const line = this.#queue.find((l) => l.startedAt === null && !l.done);
    if (!line) {
      logEvent('playback_unmatched', {});
      return;
    }
    line.startedAt = at;
    this.#audible = line;
    this.#limits.activity();
    logEvent('line_started', { id: line.id, kind: line.kind, msSinceAccepted: at - line.acceptedAt });
    if (line.kind === 'filler') this.#send({ kind: 'filler', text: line.text });
    this.#publishState();
  }

  #playbackFinished(ev: voice.PlaybackFinishedEvent): void {
    const line = this.#audible;
    this.#audible = null;
    this.#limits.activity();
    logEvent('playback_finished', { id: line?.id ?? null, interrupted: ev.interrupted, position: Number(ev.playbackPosition.toFixed(3)) });
    this.#publishState();
  }

  #lineDone(line: Line): void {
    if (line.done) return;
    line.done = true;
    line.audio?.abort.abort();
    line.interrupted = line.handle?.interrupted ?? false;
    this.#queue = this.#queue.filter((l) => l !== line);
    if (this.#audible === line) this.#audible = null;
    logEvent('line_done', { id: line.id, kind: line.kind, interrupted: line.interrupted, played: line.startedAt !== null, ms: Date.now() - line.acceptedAt });
    if (line.kind === 'answer') {
      this.#send({ kind: 'said', id: line.id, interrupted: line.interrupted });
      // The follow-up window opens when Remy finishes answering, or when that person cut in.
      if (line.to && line.startedAt !== null && (!line.interrupted || line.bargedBy === line.to)) {
        this.#addressing.answered(line.to, Date.now(), endsWithQuestion(line.text));
      }
    }
    this.#publishState();
    line.onDone?.();
  }

  #remyAudible(): boolean {
    return this.#audible !== null || this.#mouth?.agentState === 'speaking';
  }

  // ---------------------------------------------------------------- the host's lines

  /**
   * A line from the host's tab (line-gate.ts). Refused, before any sound is made of it, when it comes from anyone else,
   * when she is on her way out (`not ready`: the tab offers to call her again), when the service didn't sign it (with the
   * secret), or when it is over the call's limits (line-limits.ts).
   */
  async #onSay(data: RpcInvocationData): Promise<string> {
    const from = data.callerIdentity;
    const caller = this.#room.remoteParticipants.get(from);
    if (!caller || !isPerson(caller)) throw new RpcError(2403, 'only people on the call can hand Remy a line');
    const parsed = parseSayRequest(data.payload);
    if (!parsed.ok) {
      if (!parsed.id) throw new RpcError(2400, parsed.reason);
      return this.#refuse(parsed.id, from, parsed.reason);
    }
    const { id, text, to, proof } = parsed.request;
    const host = this.#host();
    const verdict = judgeLine({ from, host, ready: !this.#leaving && this.#mouth !== null, text, proof, secret: config.LINE_SECRET, project: this.#project });
    if (!verdict.ok) return this.#refuse(id, from, verdict.reason, { chars: text.length, ...(verdict.reason === 'not the host' ? { host } : {}), ...(proof ? { turn: proof.turn } : {}) });
    if (this.#lines.has(id)) return reply({ id, accepted: true }); // a retry of a line already taken
    const clean = verdict.words;
    const over = this.#budget.refusal(clean.length, this.#answersNotDone());
    if (over) {
      if (over === 'call budget spent') this.#budgetSpent();
      return this.#refuse(id, from, over, { chars: clean.length, spent: this.#budget.spent });
    }
    this.#budget.take(clean.length);

    const target = this.#takeWaiting(to);
    const line: Line = { id, kind: 'answer', text: clean, to: target, handle: null, acceptedAt: Date.now(), startedAt: null, done: false, interrupted: false, bargedBy: null, audio: null };
    line.audio = this.#synthesize(line);
    this.#lines.set(id, line);
    this.#filler.lineArrived();
    this.#limits.activity();
    logEvent('say_accepted', { id, from, to: target, chars: clean.length, spent: this.#budget.spent, ...(proof ? { turn: proof.turn, rewritten: clean !== text.trim() } : {}) });
    // One at a time, each waiting briefly for whoever is talking to pause.
    this.#floorChain = this.#floorChain
      .then(() => this.#floorFree())
      .then(() => {
        if (!line.done) this.#speak(line);
      })
      .catch((error: unknown) => logEvent('say_failed', { id, error: errorText(error) }));
    this.#publishState();
    return reply({ id, accepted: true });
  }

  /** A line not taken: logged with why, and answered so the tab knows. */
  #refuse(id: string, from: string, reason: string, fields: Record<string, unknown> = {}): string {
    logEvent('say_refused', { id, from, reason, ...fields });
    return reply({ id, accepted: false, reason });
  }

  /** Who hosts the call (host.ts): the person on it longest, as every tab works it out. A hidden observer is on no tab's call. */
  #host(): string | null {
    return hostOf(
      this.#people()
        .filter((p) => !p.info?.permission?.hidden)
        .map((p) => ({ identity: p.identity, joinedAt: joinedAtOf(p) })),
    );
  }

  /** Answers taken and not done: waiting for the floor, or playing. */
  #answersNotDone(): number {
    let count = 0;
    for (const line of this.#lines.values()) if (line.kind === 'answer' && !line.done) count += 1;
    return count;
  }

  /** The call's answers have used up their characters: she says so, once, and answers in the chat only. */
  #budgetSpent(): void {
    if (this.#budgetSaid) return;
    this.#budgetSaid = true;
    logEvent('limit_line_budget', { spent: this.#budget.spent, max: this.#budget.config.maxCallChars });
    void this.#sayNotice(config.BUDGET_SPENT_LINE);
  }

  /** The person a line answers: the one named, or else whoever has waited longest (waiting.ts). */
  #takeWaiting(to: string | undefined): string | null {
    this.#pruneWaiting();
    const { waiting, answered } = afterAnswer(this.#waiting, to);
    this.#waiting = waiting;
    return answered;
  }

  async #floorFree(): Promise<void> {
    if (!this.#floorTaken()) return;
    const since = Date.now();
    const until = since + config.FLOOR_WAIT_MAX_MS;
    while (this.#floorTaken() && Date.now() < until && !this.#leaving) await sleep(50);
    logEvent('floor_waited', { ms: Date.now() - since, free: !this.#floorTaken() });
  }

  /** Someone is talking: their hum gate hears sound, or their voice detector is mid-speech. */
  #floorTaken(): boolean {
    if (this.#sounding.size) return true;
    for (const ear of this.#ears.values()) if (ear.turns.speaking) return true;
    return false;
  }

  #sayFiller(text: string): void {
    const line: Line = { id: `filler-${randomUUID()}`, kind: 'filler', text, to: null, handle: null, acceptedAt: Date.now(), startedAt: null, done: false, interrupted: false, bargedBy: null, audio: null };
    this.#lines.set(line.id, line);
    logEvent('filler', { text });
    this.#speak(line, this.#fillerAudio.get(text));
  }

  /** An answer is still to come: someone said something to Remy, or a line she was handed hasn't started. */
  #answerOnItsWay(): boolean {
    this.#pruneWaiting();
    return this.#waiting.length > 0 || [...this.#lines.values()].some((line) => line.kind === 'answer' && !line.done);
  }

  /**
   * A line Remy says on her own (the call's limits): voiced like an answer, after whoever is talking pauses and after
   * any line ahead of it. Resolves once it has played, been cut off, or couldn't be said.
   */
  #sayNotice(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.#leaving || !this.#mouth) {
        resolve();
        return;
      }
      const line: Line = { id: `notice-${randomUUID()}`, kind: 'notice', text, to: null, handle: null, acceptedAt: Date.now(), startedAt: null, done: false, interrupted: false, bargedBy: null, audio: null, onDone: resolve };
      line.audio = this.#synthesize(line);
      this.#lines.set(line.id, line);
      logEvent('notice', { id: line.id, text });
      this.#floorChain = this.#floorChain
        .then(() => this.#floorFree())
        .then(() => {
          if (!line.done) this.#speak(line);
        })
        .catch((error: unknown) => {
          logEvent('notice_failed', { id: line.id, error: errorText(error) });
          this.#lineDone(line);
        });
    });
  }

  /** The call's time is up: Remy leaves, and the room is deleted, which ends the call for everyone. */
  async #timeUp(): Promise<void> {
    await this.#leaveNow('time limit', { deleteRoom: true, fields: { maxS: this.#limitsConfig.maxMs / 1000 } });
  }

  /**
   * Nobody has spoken for a while: Remy says goodbye and leaves. On the hosted worker the room goes with her, ending the
   * call for everyone, so a call nobody is using doesn't run down the visit's minutes; elsewhere the people can stay.
   * Either way they can call her back.
   */
  async #quietGoodbye(): Promise<void> {
    const ends = this.#limitsConfig.silenceEndsCall;
    logEvent('limit_silence', { silenceS: this.#limitsConfig.silenceMs / 1000, endsCall: ends });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#sayNotice(config.GOODBYE_LINE), new Promise<void>((resolve) => (timer = setTimeout(resolve, config.GOODBYE_MAX_MS)))]);
    clearTimeout(timer);
    await this.#leaveNow('silence', { deleteRoom: ends });
  }

  /**
   * Remy leaves, at once, however she goes (time up, a quiet call, everyone gone, nobody came): she takes no more lines,
   * says she is on her way out (`remy.leaving`, which the token route and the tabs read as gone, so a new call sends her
   * again), leaves the room herself, and her sessions close behind her. Left to the job's shutdown alone, closing her
   * voice session can wait out a minute's timeout with her still on the call, looking present but deaf and mute.
   */
  async #leaveNow(reason: string, { deleteRoom = false, fields = {} }: { deleteRoom?: boolean; fields?: Record<string, unknown> } = {}): Promise<void> {
    if (this.#leaving) return;
    this.#leaving = true;
    this.#cancelLeaving();
    logEvent('leaving', { reason, ...fields });
    await leaveCall(
      {
        mark: async () => {
          const local = this.#local();
          if (local && this.#room.isConnected) await local.setAttributes({ [LEAVING_ATTRIBUTE]: '1' });
        },
        ...(deleteRoom
          ? {
              deleteRoom: async () => {
                await this.#ctx.deleteRoom();
                logEvent('room_deleted', { room: this.#room.name });
              },
            }
          : {}),
        close: () => this.#close(reason),
        disconnect: () => this.#room.disconnect(),
        shutdown: () => this.#ctx.shutdown(reason),
        onError: (step, error) => logEvent('leaving_trouble', { step, ...(error === undefined ? {} : { error: errorText(error) }) }),
      },
      { markMs: config.LEAVING_MARK_MS },
    );
  }

  // ---------------------------------------------------------------- ears

  async #startEar(participant: RemoteParticipant): Promise<void> {
    const identity = participant.identity;
    if (!isPerson(participant) || this.#ears.has(identity) || this.#leaving) return;
    const turns = new TurnAssembler(identity, (turn) => this.#onTurn(turn), { holdOpen: (text) => mayContinue(text, this.#alone(identity)) });
    const session = new voice.AgentSession({
      stt: new openai.STT({ model: config.STT_MODEL, language: 'en', prompt: this.#sttPrompt(), turnDetection: null, vad: this.#vad }),
      vad: this.#vad,
      turnHandling: { turnDetection: 'stt', interruption: { mode: 'vad' }, preemptiveGeneration: { enabled: false } },
      userAwayTimeout: null,
      aecWarmupDuration: null,
    });
    const ear: Ear = { identity, session, turns, closing: false };
    this.#ears.set(identity, ear);
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        turns.speechStarted(ev.createdAt);
        this.#addressing.heardSpeech(identity, ev.createdAt);
        this.#limits.activity();
      }
      else if (ev.oldState === 'speaking') {
        turns.speechEnded(ev.createdAt);
        this.#limits.activity();
      }
    });
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal || !ev.transcript.trim()) return;
      logEvent('final', { identity, text: ev.transcript });
      turns.final(ev.transcript);
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => logEvent('ear_error', { identity, error: errorText((ev.error as { error?: unknown }).error ?? ev.error) }));
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      if (ear.closing || this.#leaving) return;
      logEvent('ear_closed', { identity, reason: ev.reason });
      this.#ears.delete(identity);
      turns.close();
      const restarts = this.#earRestarts.get(identity) ?? 0;
      const person = this.#room.remoteParticipants.get(identity);
      if (person && restarts < EAR_RESTARTS) {
        this.#earRestarts.set(identity, restarts + 1);
        setTimeout(() => void this.#startEar(person), 1000);
      }
    });
    try {
      attachRoomIO(session, this.#room, {
        participant: identity,
        inputOptions: { participantIdentity: identity, audioEnabled: true, textEnabled: false, closeOnDisconnect: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: true },
      });
      await session.start({ agent: new voice.Agent({ instructions: 'Transcribes one person. Never speaks.' }), room: this.#room, record: false });
      logEvent('ear_started', { identity, name: displayName(participant), stt: config.STT_MODEL });
    } catch (error) {
      logEvent('ear_failed', { identity, error: errorText(error) });
      this.#ears.delete(identity);
    }
  }

  async #stopEar(identity: string): Promise<void> {
    const ear = this.#ears.get(identity);
    if (!ear) return;
    ear.closing = true;
    this.#ears.delete(identity);
    ear.turns.close();
    await ear.session.close().catch(() => undefined);
    logEvent('ear_stopped', { identity });
  }

  #sttPrompt(): string {
    const names = [...new Set([config.DISPLAY_NAME, ...this.#people().map(displayName).filter(Boolean)])];
    const words = this.#hints.length ? ` Words: ${this.#hints.join(', ')}.` : '';
    return `${config.STT_SETTING} Names: ${names.join(', ')}.${words}`;
  }

  /** Nobody but this person (and Remy) is on the call now: every line of theirs is for her. */
  #alone(identity: string): boolean {
    return aloneOnCall(identity, this.#people().map((p) => p.identity));
  }

  #onTurn(turn: Turn): void {
    this.#limits.activity();
    const others = this.#people()
      .filter((p) => p.identity !== turn.identity)
      .map((p) => firstName(displayName(p)))
      .filter(Boolean);
    // Counted on every turn, so the rule follows people joining and leaving.
    const alone = this.#alone(turn.identity);
    const decision = this.#addressing.decide(turn, others, { alone });
    this.#send({ kind: 'heard', identity: turn.identity, text: turn.text, addressed: decision.addressed, final: true, at: turn.endedAt });
    logEvent('heard', {
      identity: turn.identity,
      text: turn.text,
      addressed: decision.addressed,
      reason: decision.reason,
      alone,
      summons: decision.summons,
      segments: turn.segments,
      flush: turn.reason,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      msAfterEnd: Date.now() - turn.endedAt,
    });
    if (!decision.addressed) return;
    this.#waiting.push({ identity: turn.identity, at: turn.endedAt, expiresAt: Date.now() + config.PENDING_TTL_MS });
    // A summons has nothing to answer yet, so nothing to fill.
    if (!decision.summons && config.FILLERS_ON) this.#filler.addressed(turn.endedAt);
    this.#publishState();
  }

  // ---------------------------------------------------------------- barge-in

  #startGate(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (!isPerson(participant) || track.kind !== TrackKind.KIND_AUDIO || publication.source !== TrackSource.SOURCE_MICROPHONE) return;
    if (this.#gates.get(participant.identity)?.trackSid === publication.sid) return;
    this.#stopGate(participant.identity);
    const identity = participant.identity;
    const stream = new AudioStream(track, { sampleRate: 16000, numChannels: 1, frameSizeMs: 10 });
    const gate: Gate = { identity, trackSid: publication.sid ?? '', stream, closed: false };
    this.#gates.set(identity, gate);
    const feeder = new HopFeeder(new HumGate());
    let remyAtOnset = false;
    const onEvent = (ev: HumGateEvent) => {
      if (ev.type === 'onset') {
        this.#sounding.add(identity);
        remyAtOnset = this.#remyAudible();
      } else if (ev.type === 'end') {
        this.#sounding.delete(identity);
        if (!ev.decided && remyAtOnset) logEvent('backchannel_let_through', { identity, ms: ev.durMs, open: ev.open, hum: ev.hum });
      } else {
        const audible = this.#remyAudible();
        if (audible) this.#bargeIn(identity, ev);
      }
    };
    void (async () => {
      for await (const frame of stream) {
        if (gate.closed) break;
        for (const ev of feeder.push(frame.data)) onEvent(ev);
      }
    })()
      .catch((error: unknown) => logEvent('gate_failed', { identity, error: errorText(error) }))
      .finally(() => {
        if (this.#gates.get(identity) === gate) this.#gates.delete(identity);
        this.#sounding.delete(identity);
      });
    logEvent('gate_started', { identity });
  }

  #stopGate(identity: string): void {
    const gate = this.#gates.get(identity);
    if (!gate) return;
    gate.closed = true;
    this.#gates.delete(identity);
    this.#sounding.delete(identity);
  }

  #bargeIn(identity: string, ev: Extract<HumGateEvent, { type: 'barge' }>): void {
    const live = this.#queue.filter((line) => !line.done);
    if (!live.length) return;
    for (const line of live) {
      line.bargedBy ??= identity;
      try {
        line.handle?.interrupt();
      } catch (error) {
        logEvent('interrupt_failed', { id: line.id, error: errorText(error) });
      }
    }
    logEvent('barge_in', { identity, reason: ev.reason, msAfterOnset: ev.msAfterOnset, open: ev.open, hum: ev.hum, lines: live.map((l) => ({ id: l.id, kind: l.kind })) });
  }

  // ---------------------------------------------------------------- state and messages

  #publishState(): void {
    this.#pruneWaiting();
    const thinking = this.#waiting.length > 0 || [...this.#lines.values()].some((line) => line.kind === 'answer' && !line.done && line.startedAt === null);
    const state: RemyState = this.#remyAudible() ? 'speaking' : thinking ? 'thinking' : 'listening';
    if (state === this.#state) return;
    this.#state = state;
    this.#send({ kind: 'state', state });
    this.#local()
      ?.setAttributes({ [STATE_ATTRIBUTE]: state })
      .catch((error: unknown) => logEvent('state_attribute_failed', { error: errorText(error) }));
    logEvent('state', { state });
  }

  #send(message: RemyMessage): void {
    const local = this.#local();
    if (!local || !this.#room.isConnected) return;
    local.publishData(encodeMessage(message), { reliable: true, topic: TOPIC }).catch((error: unknown) => logEvent('send_failed', { kind: message.kind, error: errorText(error) }));
  }

  #local(): LocalParticipant | undefined {
    return this.#room.localParticipant;
  }

  #people(): RemoteParticipant[] {
    return [...this.#room.remoteParticipants.values()].filter(isPerson);
  }

  #pruneWaiting(): void {
    const now = Date.now();
    this.#waiting = this.#waiting.filter((w) => w.expiresAt > now);
  }

  #tick(): void {
    this.#publishState();
    if (this.#lines.size > KEEP_DONE_LINES * 2) {
      const done = [...this.#lines.values()].filter((line) => line.done);
      for (const line of done.slice(0, done.length - KEEP_DONE_LINES)) this.#lines.delete(line.id);
    }
  }

  // ---------------------------------------------------------------- people leaving, Remy leaving

  #onLeft(p: RemoteParticipant): void {
    logEvent('left', { identity: p.identity, people: this.#people().length });
    if (!isPerson(p)) return;
    this.#stopGate(p.identity);
    this.#addressing.forget(p.identity);
    this.#waiting = this.#waiting.filter((w) => w.identity !== p.identity);
    // Their last words may still be on the way.
    setTimeout(() => {
      if (!this.#room.remoteParticipants.has(p.identity)) void this.#stopEar(p.identity);
    }, config.LEAVE_GRACE_MS);
    if (!this.#people().length) this.#leaveIfEmpty(config.EMPTY_ROOM_LEAVE_MS, 'everyone left');
    this.#publishState();
  }

  /** Nobody is on the call: she leaves after `ms`, as she does when it goes quiet (#leaveNow), unless someone comes. */
  #leaveIfEmpty(ms: number, reason: string): void {
    this.#cancelLeaving();
    this.#emptyTimer = setTimeout(() => {
      this.#emptyTimer = null;
      if (this.#people().length) return;
      void this.#leaveNow(reason);
    }, ms);
  }

  #cancelLeaving(): void {
    if (this.#emptyTimer) clearTimeout(this.#emptyTimer);
    this.#emptyTimer = null;
  }

  async #close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#leaving = true;
    logEvent('closing', { reason });
    this.#cancelLeaving();
    this.#limits.stop();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#filler.cancel();
    for (const line of this.#lines.values()) line.audio?.abort.abort();
    for (const identity of [...this.#gates.keys()]) this.#stopGate(identity);
    await Promise.allSettled([...this.#ears.keys()].map((identity) => this.#stopEar(identity)));
    await this.#mouth?.close().catch(() => undefined);
    logEvent('closed', {});
  }
}

function reply(response: SayResponse): string {
  return JSON.stringify(response);
}
