/**
 * The live tests' processes: a local `livekit-server --dev` (reused when one is listening), Remy's worker under a
 * one-off agent name with its `REMY {...}` events, and stopping everything a test started.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createConnection } from 'node:net';

export const LK_HTTP = 'http://127.0.0.1:7880';
export const LK_WS = 'ws://127.0.0.1:7880';
export const KEY = 'devkey'; // livekit-server --dev's built-in development key
export const SECRET = 'secret';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
export const say = (text: string, data?: unknown) => console.log(`[smoke] ${text}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

export const started: Array<{ name: string; proc: ChildProcess }> = [];

export const listening = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
      done(true);
    });
    socket.on('error', () => done(false));
  });

export async function waitPort(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await listening(port)) return;
    await sleep(200);
  }
  throw new Error(`port ${port} did not open`);
}

/** Reuses a server on :7880, or starts one (logging to `logFile`) that cleanup() stops. */
export async function ensureLiveKit(logFile: string): Promise<void> {
  if (await listening(7880)) {
    say('reusing livekit-server on :7880');
    return;
  }
  const server = spawn('livekit-server', ['--dev', '--bind', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(logFile);
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  started.push({ name: 'livekit-server', proc: server });
  await waitPort(7880, 20000);
  say('started livekit-server');
}

export interface WorkerEvent {
  event: string;
  t: number;
  [key: string]: unknown;
}

export class Worker {
  readonly events: WorkerEvent[] = [];
  readonly proc: ChildProcess;
  #waiters = new Set<() => void>();
  registered = false;

  /** Remy's worker from `dir` (a copy of the package's, for comparing builds), logging to `logFile`. */
  constructor(dir: string, logFile: string, env: Record<string, string>) {
    this.proc = spawn(process.execPath, ['--env-file-if-exists=../../.env.local', 'src/main.ts', 'dev'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LIVEKIT_URL: LK_WS, LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, ...env },
    });
    started.push({ name: 'worker', proc: this.proc });
    const log = createWriteStream(logFile);
    let buffer = '';
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (/registered worker/.test(line)) this.registered = true;
        const at = line.indexOf('REMY {');
        if (at >= 0) {
          try {
            this.events.push(JSON.parse(line.slice(at + 6)) as WorkerEvent);
          } catch {
            // a partial line
          }
        }
        for (const waiter of this.#waiters) waiter();
      }
    };
    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
  }

  waitFor(pred: (e: WorkerEvent) => boolean, ms: number): Promise<WorkerEvent | null> {
    return new Promise((resolve) => {
      const check = () => {
        const found = this.events.find(pred);
        if (found) finish(found);
        return Boolean(found);
      };
      const finish = (e: WorkerEvent | null) => {
        this.#waiters.delete(check);
        clearTimeout(timer);
        resolve(e);
      };
      const timer = setTimeout(() => finish(null), ms);
      if (!check()) this.#waiters.add(check);
    });
  }

  async until(cond: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await sleep(100);
    }
    return cond();
  }
}

export async function stop(proc: ChildProcess, name: string, ms = 8000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode) return;
  let kids: number[] = [];
  try {
    kids = execSync(`pgrep -P ${proc.pid}`).toString().split('\n').filter(Boolean).map(Number);
  } catch {
    // no children
  }
  proc.kill('SIGINT');
  const end = Date.now() + ms;
  while (Date.now() < end && proc.exitCode === null && !proc.signalCode) await sleep(100);
  if (proc.exitCode === null && !proc.signalCode) proc.kill('SIGKILL');
  for (const kid of kids) {
    try {
      process.kill(kid, 0);
      process.kill(kid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  say(`stopped ${name}`);
}

/** Stops everything the test started: the worker first, then the server. */
export async function stopStarted(): Promise<void> {
  for (const s of started.filter((x) => x.name === 'worker')) await stop(s.proc, s.name);
  for (const s of started.filter((x) => x.name !== 'worker')) {
    s.proc.kill('SIGTERM');
    say(`stopped ${s.name}`);
  }
}
