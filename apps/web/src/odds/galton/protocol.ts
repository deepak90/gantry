/** What the board (galton/odds-galton.ts) and its physics worker (galton/galton.worker.ts) say to each other. */
import type { BoardLayout } from './board';
import type { PhysicsSpec } from './physics';

/** A run waiting for its fall: `pass` tells the falls of one pass from the next (run numbers repeat). */
export interface Need {
  pass: number;
  run: number;
  bin: number;
}

export type ToWorker =
  | { type: 'board'; layout: BoardLayout; physics: PhysicsSpec; seed: number }
  /** What the next pass is expected to need: a weight per bin, and how many runs. */
  | { type: 'expect'; weights: number[]; total: number }
  | { type: 'need'; items: Need[] }
  /** A new pass: the runs still waiting are forgotten. */
  | { type: 'forget' };

export interface FallItem extends Need {
  /** Where its frames start in `frames` (in floats), and how many frames it has. */
  offset: number;
  count: number;
  vx: number;
  vy: number;
}

export interface WorkerStats {
  /** Falls simulated, of them drops aimed at a rare bin, and how many of those reached it. */
  tried: number;
  aimed: number;
  aimHits: number;
  failed: number;
  /** Falls handed to runs. */
  handedOut: number;
  /** Milliseconds spent inside the physics. */
  simulateMs: number;
  /** Falls ready in stock. */
  stocked: number;
  /** Rapier's load and the world's build, in milliseconds. */
  setupMs: number;
}

export type FromWorker =
  | { type: 'ready'; setupMs: number }
  | { type: 'falls'; items: FallItem[]; frames: Float32Array; stats: WorkerStats }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'error'; message: string };
