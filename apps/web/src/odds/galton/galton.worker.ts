/**
 * The board's physics, off the main thread: Rapier (loaded here, on first use, so the app's own bundle never carries
 * it) simulates drops through the board in batches, the drop cache keeps every fall for the bin it reached, and runs
 * are handed their falls in the order they asked. The search goes on while any bin is short of what the pass is
 * expected to need, and rests otherwise.
 */
/// <reference lib="webworker" />
import { binAt, type BoardLayout } from './board';
import { DropCache, seededRandom } from './drop-cache';
import { createBoardWorld, type BoardWorld, type Fall, type Rapier } from './physics';
import type { FallItem, FromWorker, Need, ToWorker, WorkerStats } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const BATCH = 32;

let rapier: Promise<Rapier> | null = null;
let world: BoardWorld | null = null;
let cache: DropCache<Fall> | null = null;
let layout: BoardLayout | null = null;
let queue: Need[] = [];
let running = false;
let simulateMs = 0;
let setupMs = 0;
let generation = 0;
let statsAt = 0;

function loadRapier(): Promise<Rapier> {
  rapier ??= import('@dimforge/rapier3d-compat').then(async (module) => {
    const R = (module.default ?? module) as Rapier;
    await R.init();
    return R;
  });
  return rapier;
}

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

function stats(): WorkerStats {
  const s = cache?.stats ?? { tried: 0, aimed: 0, aimHits: 0, failed: 0, handedOut: 0 };
  let stocked = 0;
  if (cache) for (let bin = 0; bin < cache.bins; bin += 1) stocked += cache.stock(bin);
  return { ...s, simulateMs, stocked, setupMs };
}

/** Hands out what is ready, oldest run first; a run whose bin has nothing ready waits its turn without holding up others. */
function serve(): void {
  if (!cache || queue.length === 0) return;
  const items: FallItem[] = [];
  const chunks: Float32Array[] = [];
  let floats = 0;
  const still: Need[] = [];
  for (const need of queue) {
    const fall = cache.take(need.bin);
    if (!fall) {
      still.push(need);
      continue;
    }
    items.push({ ...need, offset: floats, count: fall.frames.length / 2, vx: fall.vx, vy: fall.vy });
    chunks.push(fall.frames);
    floats += fall.frames.length;
  }
  queue = still;
  updateWaiting();
  if (items.length === 0) return;
  const frames = new Float32Array(floats);
  let at = 0;
  for (const chunk of chunks) {
    frames.set(chunk, at);
    at += chunk.length;
  }
  post({ type: 'falls', items, frames, stats: stats() }, [frames.buffer]);
}

function updateWaiting(): void {
  if (!cache) return;
  const waiting = new Array<number>(cache.bins).fill(0);
  for (const need of queue) waiting[need.bin] = (waiting[need.bin] ?? 0) + 1;
  cache.setWaiting(waiting);
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Simulates while there is anything to find, a batch at a time, with a turn for messages between batches. */
async function search(): Promise<void> {
  if (running) return;
  running = true;
  const mine = generation;
  try {
    while (world && cache && layout && mine === generation && (queue.length > 0 || cache.hungry())) {
      const plan = cache.next(BATCH);
      const started = performance.now();
      const falls = world.simulate(plan.map((entry) => entry.drop));
      simulateMs += performance.now() - started;
      falls.forEach((fall, index) => {
        const aimedAt = plan[index]!.aimedAt;
        if (fall) cache!.add(fall, aimedAt);
        else cache!.lost(aimedAt);
      });
      serve();
      const at = performance.now();
      if (at - statsAt > 250) {
        statsAt = at;
        post({ type: 'stats', stats: stats() });
      }
      await turn();
    }
    post({ type: 'stats', stats: stats() });
  } finally {
    running = false;
    // A new board arrived meanwhile: its search starts now.
    if (mine !== generation) void search();
  }
}

async function handle(message: ToWorker): Promise<void> {
  try {
    switch (message.type) {
      case 'board': {
        generation += 1;
        const started = performance.now();
        const R = await loadRapier();
        world?.dispose();
        layout = message.layout;
        world = createBoardWorld(R, layout, message.physics);
        const random = seededRandom(message.seed);
        const middle = layout.hopper.center;
        const under = binAt(layout, middle);
        cache = new DropCache<Fall>({
          bins: layout.bins.length,
          release: layout.release,
          sideOf: (bin) => (under >= 0 && bin === under ? 0 : layout!.bins[bin]!.center < middle ? -1 : 1),
          random,
        });
        queue = [];
        simulateMs = 0;
        setupMs = performance.now() - started;
        post({ type: 'ready', setupMs });
        void search();
        break;
      }
      case 'expect':
        cache?.expect(message.weights, message.total);
        void search();
        break;
      case 'need':
        queue.push(...message.items);
        updateWaiting();
        serve();
        void search();
        break;
      case 'forget':
        queue = [];
        updateWaiting();
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

// One message at a time, in order: what comes while Rapier loads waits for the board it is about.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<ToWorker>) => {
  chain = chain.then(() => handle(event.data));
};
