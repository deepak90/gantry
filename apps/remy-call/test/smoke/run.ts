/**
 * A live smoke test of Remy's call worker against a local `livekit-server --dev`.
 *
 *   pnpm --filter @collab/remy-call smoke [--clips <dir>[,<dir>]] [--cache <dir>] [--out <dir>] [--spend-log <file>] [--worker <dir>]
 *
 * It reuses a server already listening on 127.0.0.1:7880, or starts one and stops it afterward. It
 * starts the worker under a one-off agent name (so it can never take a real call's dispatch), puts
 * three caller bots and a hidden observer in a fresh room, plays the cue script, and checks what
 * Remy heard, what she said, and how fast she stopped. Everything the test started, it stops. Outputs
 * (report, WAVs, worker log) go to --out, by default under the OS temp folder. `--worker` runs a copy of the worker
 * from another folder (a `src/` beside this package's node_modules), to compare builds.
 * OpenAI cost: a few cents a run (live transcription for three callers, Remy's speech).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dispose, RpcError } from '@livekit/rtc-node';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { SAY_METHOD, STATE_ATTRIBUTE } from '../../src/messages.ts';
import { CallerBot, Observer, type Played, type TrackRecording } from './bots.ts';
import { loadClips } from './clips.ts';
import { ensureLiveKit, KEY, LK_HTTP, LK_WS, say, SECRET, sleep, stop, stopStarted, Worker } from './harness.ts';
import { CAST, LINES, REPLIES, type Who } from './script.ts';

const { values: args } = parseArgs({
  options: { clips: { type: 'string' }, cache: { type: 'string' }, out: { type: 'string' }, 'spend-log': { type: 'string' }, worker: { type: 'string' } },
});
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const OUT = resolve(args.out ?? join(tmpdir(), 'remy-call-smoke', STAMP));
const CACHE = resolve(args.cache ?? join(tmpdir(), 'remy-call-smoke', 'clips'));
const CLIP_DIRS = (args.clips ?? '').split(',').filter(Boolean).map((dir) => resolve(dir));
const AGENT = `remy-smoke-${STAMP.toLowerCase()}`;
const ROOM = `project-smoke-${STAMP.toLowerCase()}`;
const USD_PER_MIN = { stt: 0.003, tts: 0.015 };

// ------------------------------------------------------------------ tokens

async function token(identity: string, name: string, attributes: Record<string, string>, hidden = false): Promise<string> {
  const at = new AccessToken(KEY, SECRET, { identity, name, attributes, ttl: '20m' });
  at.addGrant(
    hidden
      ? { roomJoin: true, room: ROOM, canPublish: false, canSubscribe: true, canPublishData: false, hidden: true, recorder: true }
      : { roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true, canPublishData: true },
  );
  return at.toJwt();
}

// ------------------------------------------------------------------ analysis helpers

const LOUD_DB = -45;
const at = (rec: TrackRecording, k: number) => rec.firstAt + k * 10;
const index = (rec: TrackRecording, t: number) => Math.max(0, Math.round((t - rec.firstAt) / 10));

function firstLoud(rec: TrackRecording | undefined, from: number, to: number, db = LOUD_DB): number | null {
  if (!rec) return null;
  for (let k = index(rec, from); k < Math.min(rec.levels.length, index(rec, to)); k++) if ((rec.levels[k] ?? -120) > db) return at(rec, k);
  return null;
}

/** End of the last loud frame between `from` and `to`. */
function lastLoud(rec: TrackRecording | undefined, from: number, to: number, db = LOUD_DB): number | null {
  if (!rec) return null;
  for (let k = Math.min(rec.levels.length, index(rec, to)) - 1; k >= index(rec, from); k--) if ((rec.levels[k] ?? -120) > db) return at(rec, k + 1);
  return null;
}

/** End of the last loud frame before `quietMs` of quiet, searching from `from`. */
function endBeforeQuiet(rec: TrackRecording | undefined, from: number, quietMs: number, db = LOUD_DB): number | null {
  if (!rec) return null;
  let lastLoud: number | null = null;
  for (let k = index(rec, from); k < rec.levels.length; k++) {
    if ((rec.levels[k] ?? -120) > db) lastLoud = k;
    else if ((k - (lastLoud ?? index(rec, from))) * 10 >= quietMs) return lastLoud === null ? at(rec, index(rec, from)) : at(rec, lastLoud + 1);
  }
  return lastLoud === null ? null : at(rec, lastLoud + 1);
}

// ------------------------------------------------------------------ the run

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  say('out', OUT);
  const lineIds = Object.keys(LINES);
  const clips = await loadClips(lineIds, CLIP_DIRS, CACHE);
  say('clips', Object.fromEntries([...clips.values()].map((c) => [c.id, `${c.source} ${(c.samples.length / c.sampleRate).toFixed(2)} s`])));

  await ensureLiveKit(join(OUT, 'livekit.log'));

  const worker = new Worker(args.worker ? resolve(args.worker) : PKG, join(OUT, 'worker.log'), { REMY_AGENT_NAME: AGENT });
  if (!(await worker.until(() => worker.registered, 30000))) throw new Error('the worker did not register');
  say('worker registered', { agent: AGENT });

  const rooms = new RoomServiceClient(LK_HTTP, KEY, SECRET);
  await rooms.createRoom({ name: ROOM, emptyTimeout: 60, departureTimeout: 20 });

  const observer = new Observer();
  await observer.join(LK_WS, await token('observer', 'Observer', {}, true));
  const ids: Record<Who, string> = { deepak: `smoke-deepak-${STAMP}`, nora: `smoke-nora-${STAMP}`, tony: `smoke-tony-${STAMP}` };
  const bots: Record<Who, CallerBot> = {
    deepak: new CallerBot('deepak', ids.deepak),
    nora: new CallerBot('nora', ids.nora),
    tony: new CallerBot('tony', ids.tony),
  };
  const join_ = async (who: Who) => {
    const cast = CAST[who];
    await bots[who].join(LK_WS, await token(ids[who], cast.name, { name: cast.name, color: cast.color, role: cast.role }));
  };

  // Deepak is there first; Remy comes; then the others join a call in progress.
  await join_('deepak');
  const dispatchAt = Date.now();
  await new AgentDispatchClient(LK_HTTP, KEY, SECRET).createDispatch(ROOM, AGENT, { metadata: JSON.stringify({ hints: ['Granite Ridge', 'footings', 'slab', 'crane', 'Thanksgiving'] }) });
  const remyJoined = await observer.waitFor((e) => e.type === 'joined' && e.from === 'remy', 20000);
  if (!remyJoined) throw new Error('Remy did not join');
  await Promise.all([join_('nora'), join_('tony')]);
  const ready = await worker.until(
    () => ['deepak', 'nora', 'tony'].every((w) => worker.events.some((e) => e.event === 'ear_started' && e.identity === ids[w as Who])) && worker.events.some((e) => e.event === 'fillers_ready') && observer.tracks.has('remy'),
    30000,
  );
  if (!ready) throw new Error('not ready: ears, fillers or Remy’s track missing');
  const readyAt = Date.now();
  say('all in', { remyJoinedMs: remyJoined.t - dispatchAt, readyMs: readyAt - dispatchAt });
  await sleep(1500);

  // ---------------------------------------------------------------- the cue script
  const played: Record<string, Played & { who: Who }> = {};
  const rpcs: Array<{ id: string; payload: string; response: string | null; error: string | null; ms: number; at: number }> = [];
  const play = async (id: string) => {
    const line = LINES[id]!;
    const clip = clips.get(id)!;
    say(`plays ${id}`, { who: line.who });
    const p = await bots[line.who].play(clip.samples);
    played[id] = { ...p, who: line.who };
    return played[id]!;
  };
  const rpc = async (payload: string) => {
    const t = Date.now();
    try {
      const response = await bots.deepak.room.localParticipant!.performRpc({ destinationIdentity: 'remy', method: SAY_METHOD, payload, responseTimeout: 5000 });
      rpcs.push({ id: (JSON.parse(payload) as { id?: string }).id ?? '?', payload, response, error: null, ms: Date.now() - t, at: t });
      return response;
    } catch (error) {
      const text = error instanceof RpcError ? `RpcError ${error.code}: ${error.message}` : String(error);
      rpcs.push({ id: '?', payload, response: null, error: text, ms: Date.now() - t, at: t });
      return null;
    }
  };
  const hostSays = (id: keyof typeof REPLIES, to?: string) => rpc(JSON.stringify({ id, text: REPLIES[id], ...(to ? { to } : {}) }));
  const heardFrom = (who: Who, after: number) =>
    observer.waitFor((e) => e.type === 'message' && e.message?.kind === 'heard' && e.message.identity === ids[who] && e.message.at >= after - 300, 15000);
  const lineStarted = (id: string) => worker.waitFor((e) => e.event === 'line_started' && e.id === id, 30000);
  const said = (id: string) => observer.waitFor((e) => e.type === 'message' && e.message?.kind === 'said' && e.message.id === id, 45000);

  // 1. Deepak asks; the "brain" takes 2.5 s (a filler is due); Nora hums during the answer.
  const d1 = await play('d1');
  await heardFrom('deepak', d1.startAt);
  await sleep(2500);
  await hostSays('a1', ids.deepak);
  const a1 = await lineStarted('a1');
  if (a1) await sleep(a1.t + 3500 - Date.now());
  await play('n1');
  await said('a1');

  // 2. Tony and Nora talk to each other (one names Remy in passing), then Tony asks Remy and
  //    gets an instant reply, which Deepak cuts off with "Wait—".
  await sleep(1300);
  await play('t1');
  await sleep(450);
  await play('n2');
  await sleep(900);
  const t2 = await play('t2');
  await heardFrom('tony', t2.startAt);
  await hostSays('a2', ids.tony);
  const a2 = await lineStarted('a2');
  if (a2) await sleep(a2.t + 2200 - Date.now());
  const d2 = await play('d2');
  await heardFrom('deepak', d2.startAt);
  await sleep(1000);
  await hostSays('a3', ids.deepak);
  await said('a3');

  // 3. Tony talks to Nora (his own answer was cut off by Deepak, so no follow-up for him); then
  //    Deepak follows up without the name. The host doesn't say who it answers: Remy works it out.
  await sleep(1000);
  await play('t3');
  await sleep(500);
  const f1 = await play('f1');
  await heardFrom('deepak', f1.startAt);
  await sleep(2000);
  await hostSays('a4');
  await said('a4');

  // 4. remy.say edge cases: an empty line, a retry of a line already said, a payload that isn't JSON.
  const empty = await rpc(JSON.stringify({ id: 'empty-1', text: '   ' }));
  const retry = await hostSays('a4');
  const garbage = await rpc('not json');
  await sleep(1500);

  // ---------------------------------------------------------------- leave
  const leftAt = Date.now();
  for (const bot of Object.values(bots)) await bot.leave();
  const remyLeft = await observer.waitFor((e) => e.type === 'left' && e.from === 'remy', 15000);
  await sleep(500);
  await observer.leave();
  await stop(worker.proc, 'worker');
  await rooms.deleteRoom(ROOM).catch(() => undefined);
  const wavs = observer.saveWavs(OUT);

  // ---------------------------------------------------------------- checks
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const msgs = observer.messages();
  const heard = msgs.flatMap(({ t, message }) => (message.kind === 'heard' ? [{ t, ...message }] : []));
  const fillers = msgs.flatMap(({ t, message }) => (message.kind === 'filler' ? [{ t, ...message }] : []));
  const saids = msgs.flatMap(({ t, message }) => (message.kind === 'said' ? [{ t, ...message }] : []));
  const states = msgs.flatMap(({ message }) => (message.kind === 'state' ? [message.state] : []));
  const remy = observer.tracks.get('remy');
  const track = (who: Who) => observer.tracks.get(ids[who]);
  const workerHeard = worker.events.filter((e) => e.event === 'heard');

  check(
    'Remy joins as `remy`, name "Remy"',
    Boolean(remyJoined) && remyJoined?.changed?.name === 'Remy',
    `in the room ${remyJoined ? remyJoined.t - dispatchAt : '?'} ms after the dispatch, attributes ${JSON.stringify(remyJoined?.changed ?? {})}; all ears ready ${readyAt - dispatchAt} ms after`,
  );

  const timeline: Record<string, unknown> = {};
  for (const [id, line] of Object.entries(LINES)) {
    const p = played[id];
    if (!p) {
      check(`line ${id}`, false, 'not played');
      continue;
    }
    const rec = track(line.who);
    const clip = clips.get(id);
    const clipMs = clip ? (clip.samples.length / clip.sampleRate) * 1000 : 0;
    const onset = firstLoud(rec, p.startAt - 300, p.endAt + 300, -40);
    const end = onset === null ? null : lastLoud(rec, onset, onset + clipMs + 300);
    const got = heard.filter((h) => h.identity === ids[line.who] && h.at >= p.startAt - 300 && h.at <= p.endAt + 2500);
    const reasons = workerHeard.filter((e) => e.identity === ids[line.who] && typeof e.endedAt === 'number' && e.endedAt >= p.startAt - 300 && e.endedAt <= p.endAt + 2500).map((e) => e.reason);
    timeline[id] = { who: line.who, onset, end, heard: got.map((h) => ({ text: h.text, addressed: h.addressed, msAfterLineEnd: end === null ? null : h.t - end })), reasons };
    if (line.hum) {
      check(`"${line.say}" (${line.who}) is not for Remy`, got.every((h) => !h.addressed), got.length ? got.map((h) => `heard "${h.text}" addressed=${h.addressed}`).join('; ') : 'not transcribed (a hum)');
      continue;
    }
    const wrongSpeaker = heard.filter((h) => h.identity !== ids[line.who] && h.at >= p.startAt && h.at <= p.endAt && h.text.length > 12);
    const addressedOk = got.length > 0 && got.every((h) => h.addressed === line.addressed);
    const heardMs = end === null || !got.length ? null : (got.at(-1)?.t ?? 0) - end;
    check(
      `${id} (${line.who}) heard, ${line.addressed ? 'addressed' : 'not addressed'}`,
      addressedOk && wrongSpeaker.length === 0,
      `${got.map((h, i) => `"${h.text}" addressed=${h.addressed} (${String(reasons[i] ?? '')})`).join(' | ') || 'nothing heard'}; heard ${heardMs ?? '?'} ms after the line ended`,
    );
  }

  // Answers and fillers after addressed lines: what came first, and how soon after the line ended.
  const firstSound = (id: string) => {
    const end = (timeline[id] as { end: number | null } | undefined)?.end ?? null;
    const sound = end === null ? null : firstLoud(remy, end, end + 15000);
    return { end, sound, ms: end !== null && sound !== null ? sound - end : null };
  };
  const fillerAfter = (id: string, ms: number) => {
    const p = played[id];
    return p ? fillers.find((f) => f.t >= p.startAt && f.t <= p.endAt + ms) : undefined;
  };
  for (const [id, expectFiller, why] of [
    ['d1', true, 'the reply took 2.5 s'],
    ['t2', false, 'the reply came at once'],
    ['d2', true, 'the reply took 1 s after the transcript'],
    ['f1', true, 'the reply took 2 s'],
  ] as const) {
    const filler = fillerAfter(id, 6000);
    const sound = firstSound(id);
    check(
      `${id}: ${expectFiller ? 'a filler' : 'no filler'} (${why}), first sound within 2.5 s`,
      Boolean(filler) === expectFiller && sound.ms !== null && sound.ms <= 2500,
      `${filler ? `filler "${filler.text}"` : 'no filler'}; Remy heard ${sound.ms ?? '?'} ms after the line ended`,
    );
  }
  for (const id of ['t1', 'n2', 't3']) {
    const p = played[id];
    const after = p ? worker.events.filter((e) => (e.event === 'filler' || e.event === 'say_accepted') && e.t >= p.startAt && e.t <= p.endAt + 3000) : [];
    check(`${id}: Remy stays quiet`, after.length === 0, after.length ? after.map((e) => e.event).join(', ') : 'no filler, nothing said');
  }

  // Barge-in
  const d2Onset = (timeline.d2 as { onset: number | null } | undefined)?.onset ?? null;
  const remyStop = d2Onset === null ? null : endBeforeQuiet(remy, d2Onset, 800);
  const a2Said = saids.find((s) => s.id === 'a2');
  const bargeMs = d2Onset !== null && remyStop !== null ? remyStop - d2Onset : null;
  const bargeEvent = worker.events.find((e) => e.event === 'barge_in' && e.identity === ids.deepak);
  check('"Wait—" stops Remy within 400 ms', bargeMs !== null && bargeMs <= 400 && a2Said?.interrupted === true, `Remy silent ${bargeMs ?? '?'} ms after Deepak's onset (gate decided ${String(bargeEvent?.msAfterOnset ?? '?')} ms in); said a2 interrupted=${a2Said?.interrupted}`);
  const n1 = played.n1;
  const a1Said = saids.find((s) => s.id === 'a1');
  const humBarge = n1 ? worker.events.filter((e) => e.event === 'barge_in' && e.t >= n1.startAt && e.t <= n1.endAt + 1000) : [];
  const letThrough = worker.events.find((e) => e.event === 'backchannel_let_through' && e.identity === ids.nora);
  check('"Mm-hm" does not stop Remy', humBarge.length === 0 && a1Said?.interrupted === false, `said a1 interrupted=${a1Said?.interrupted}; ${letThrough ? `hum let through (${String(letThrough.ms)} ms, open ${String(letThrough.open)}, hum ${String(letThrough.hum)})` : 'no hum event'}`);

  // remy.say and said
  const answers = ['a1', 'a2', 'a3', 'a4'];
  const accepted = answers.map((id) => rpcs.find((r) => r.payload.includes(`"id":"${id}"`)));
  check('remy.say answers at once', accepted.every((r) => r?.response && (JSON.parse(r.response) as { accepted: boolean }).accepted && r.ms < 500), accepted.map((r) => `${r?.id}: ${r?.response} in ${r?.ms} ms`).join('; '));
  check('said arrives for every line', answers.every((id) => saids.some((s) => s.id === id)), saids.map((s) => `${s.id} interrupted=${s.interrupted}`).join('; '));
  const replays = worker.events.filter((e) => e.event === 'line_started' && e.id === 'a4').length;
  check('remy.say edge cases', empty === '{"id":"empty-1","accepted":false,"reason":"empty"}' && retry === '{"id":"a4","accepted":true}' && replays === 1 && garbage === null, `empty → ${empty}; retry → ${retry} (played ${replays}x); not JSON → ${rpcs.at(-1)?.error}`);
  const a4To = worker.events.find((e) => e.event === 'say_accepted' && e.id === 'a4')?.to;
  check('a reply without `to` answers whoever waited longest', a4To === ids.deepak, `a4 → ${String(a4To)}`);

  // State and captions
  const stateAttrs = observer.events.filter((e) => e.type === 'attributes' && e.from === 'remy' && e.changed?.[STATE_ATTRIBUTE]).map((e) => e.changed?.[STATE_ATTRIBUTE]);
  check(
    'state on the topic and on lk.agent.state',
    ['listening', 'thinking', 'speaking'].every((s) => (states as string[]).includes(s) && stateAttrs.includes(s)),
    `messages: ${states.join(' → ')} | attribute: ${stateAttrs.join(' → ')}`,
  );
  // People's captions come as interim streams and a final one; Remy's as one stream per line, final when it closes.
  const captionsFrom = new Set(observer.events.filter((e) => e.type === 'caption' && (e.final || e.from === 'remy')).map((e) => e.from));
  check('captions on lk.transcription for every speaker', [...Object.values(ids), 'remy'].every((id) => captionsFrom.has(id)), [...captionsFrom].join(', '));
  check('Remy leaves when everyone has', Boolean(remyLeft), remyLeft ? `${remyLeft.t - leftAt} ms after the last bot left` : 'still there');

  // ---------------------------------------------------------------- spend and report
  const callSeconds = (leftAt - readyAt) / 1000 + (readyAt - dispatchAt) / 1000;
  const sttMinutes = (3 * callSeconds) / 60;
  const ttsSeconds = worker.events.filter((e) => e.event === 'tts').reduce((sum, e) => sum + Number(e.audioMs ?? 0) / 1000, 0);
  const madeSeconds = [...clips.values()].reduce((sum, c) => sum + c.madeSeconds, 0);
  const usd = sttMinutes * USD_PER_MIN.stt + ((ttsSeconds + madeSeconds) / 60) * USD_PER_MIN.tts;
  const spend = { run: STAMP, sttMinutes: Number(sttMinutes.toFixed(2)), ttsSeconds: Number(ttsSeconds.toFixed(1)), clipSeconds: Number(madeSeconds.toFixed(1)), usd: Number(usd.toFixed(4)) };
  if (args['spend-log']) appendFileSync(resolve(args['spend-log']), `${JSON.stringify(spend)}\n`);

  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ room: ROOM, agent: AGENT, checks, timeline, rpcs, spend, wavs, messages: msgs, observed: observer.events.filter((e) => e.type !== 'message'), worker: worker.events }, null, 1),
  );
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  say('spend', spend);
  say('report', join(OUT, 'report.json'));
  return checks.every((c) => c.pass) ? 0 : 1;
}

async function cleanup(): Promise<void> {
  await stopStarted();
  await dispose().catch(() => undefined);
}

process.on('SIGINT', () => {
  void cleanup().then(() => process.exit(130));
});

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('[smoke] FAILED', error);
} finally {
  await cleanup();
}
process.exit(code);
