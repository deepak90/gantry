/**
 * The board's physics, with Rapier: the pegs, the dividers, the walls and the hopper as fixed colliders, and marbles
 * that collide with them and never with each other. A batch of drops falls together in one world (their collision
 * groups keep them apart), each fall is recorded at 60 frames a second until the marble is committed to a bin, and
 * the bodies are taken out again. Runs in the board's worker (galton/galton.worker.ts); the main thread only plays
 * the recordings back.
 */
import type * as RapierModule from '@dimforge/rapier3d-compat';
import { binAt, MARBLE_RADIUS, type BoardLayout } from './board';

export type Rapier = typeof RapierModule;

export interface PhysicsSpec {
  /** Units (marble diameters) per second squared. */
  gravity: number;
  restitution: number;
  friction: number;
  /** Seconds per step. */
  step: number;
  /** Steps per recorded frame. */
  stepsPerFrame: number;
  /** A fall that hasn't reached a bin by then is dropped (a marble balanced on a peg, say). */
  maxSeconds: number;
  /** Continuous collision detection: steps can then be longer, but a batch's marbles are no longer independent. */
  ccd: boolean;
}

/** About half real gravity for a board a meter wide: a cinematic fall of about two seconds. */
export const DEFAULT_PHYSICS: PhysicsSpec = {
  gravity: 640,
  restitution: 0.6,
  friction: 0.2,
  step: 1 / 120,
  stepsPerFrame: 2,
  // Longer falls (a marble that lingers on a peg) are left out: the board settles soon after the last run.
  maxSeconds: 3,
  ccd: true,
};

/** Recorded frames per second. */
export const frameRate = (spec: PhysicsSpec): number => 1 / (spec.step * spec.stepsPerFrame);

/** How a marble is let go: where across the hopper's mouth, and a tiny push and spin. */
export interface Drop {
  x: number;
  vx: number;
  spin: number;
}

export interface Fall {
  drop: Drop;
  bin: number;
  /** x and y in turn, one pair per frame, from the moment it is let go to the moment it is committed to its bin. */
  frames: Float32Array;
  /** Its velocity at the last frame, to carry on into the bin. */
  vx: number;
  vy: number;
}

export interface BoardWorld {
  /** Lets every drop fall at once; a fall that never reaches a bin comes back null. */
  simulate(drops: readonly Drop[]): (Fall | null)[];
  /** Simulation steps taken so far (each covers every marble in its batch). */
  readonly steps: number;
  dispose(): void;
}

// Interaction groups: the high 16 bits are the groups a collider is in, the low 16 the groups it collides with.
const BOARD_GROUPS = (0x0001 << 16) | 0x0002;
const MARBLE_GROUPS = (0x0002 << 16) | 0x0001;
/** A quarter turn about x: Rapier's cylinders stand along y, the pegs point out of the board along z. */
const ALONG_Z = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
const DEPTH = 1.6;

export function createBoardWorld(R: Rapier, layout: BoardLayout, spec: PhysicsSpec = DEFAULT_PHYSICS): BoardWorld {
  const world = new R.World({ x: 0, y: -spec.gravity, z: 0 });
  world.timestep = spec.step;
  const board = world.createRigidBody(R.RigidBodyDesc.fixed());
  const add = (desc: RapierModule.ColliderDesc) => world.createCollider(desc.setRestitution(spec.restitution).setFriction(spec.friction).setCollisionGroups(BOARD_GROUPS), board);

  const { pegs, shape } = layout;
  for (let i = 0; i < pegs.length; i += 2) add(R.ColliderDesc.cylinder(DEPTH / 2, shape.pegRadius).setTranslation(pegs[i]!, pegs[i + 1]!, 0).setRotation(ALONG_Z));
  for (const divider of layout.dividers) add(R.ColliderDesc.cuboid(divider.thickness / 2, divider.top / 2, DEPTH / 2).setTranslation(divider.x, divider.top / 2, 0));
  // Side walls up past the hopper, and the floor.
  const wallHeight = layout.top + 40;
  add(R.ColliderDesc.cuboid(1, wallHeight / 2, DEPTH / 2).setTranslation(layout.left - 1, wallHeight / 2, 0));
  add(R.ColliderDesc.cuboid(1, wallHeight / 2, DEPTH / 2).setTranslation(layout.right + 1, wallHeight / 2, 0));
  add(R.ColliderDesc.cuboid((layout.right - layout.left) / 2 + 2, 1, DEPTH / 2).setTranslation(0, -1, 0));
  // The hopper: two walls rising up and outward from the edges of its mouth.
  const { hopper } = layout;
  for (const side of [-1, 1]) {
    const angle = side * hopper.slope;
    const half = hopper.wallLength / 2;
    const thickness = 0.5;
    // From the mouth's edge, along the wall's direction (up and outward), offset by half its thickness outward.
    const edge = hopper.center + side * (hopper.exit / 2 + thickness / 2);
    const cx = edge + side * Math.sin(hopper.slope) * half;
    const cy = hopper.y + Math.cos(hopper.slope) * half;
    add(R.ColliderDesc.cuboid(thickness / 2, half, DEPTH / 2).setTranslation(cx, cy, 0).setRotation({ x: 0, y: 0, z: Math.sin(-angle / 2), w: Math.cos(-angle / 2) }));
  }

  const maxSteps = Math.ceil(spec.maxSeconds / spec.step);
  let steps = 0;

  return {
    get steps() {
      return steps;
    },
    simulate(drops) {
      const marbles = drops.map((drop) => {
        const body = world.createRigidBody(
          R.RigidBodyDesc.dynamic()
            .setTranslation(drop.x, layout.release.y, 0)
            .setLinvel(drop.vx, -0.6, 0)
            .setAngvel({ x: 0, y: 0, z: drop.spin })
            .enabledTranslations(true, true, false)
            .enabledRotations(false, false, true)
            .setCcdEnabled(spec.ccd),
        );
        world.createCollider(R.ColliderDesc.ball(MARBLE_RADIUS).setDensity(2.5).setRestitution(spec.restitution).setFriction(spec.friction).setCollisionGroups(MARBLE_GROUPS), body);
        const first = body.translation();
        return { drop, body, frames: [first.x, first.y] as number[], fall: null as Fall | null, done: false };
      });
      let open = marbles.length;
      for (let step = 1; step <= maxSteps && open > 0; step += 1) {
        world.step();
        steps += 1;
        const record = step % spec.stepsPerFrame === 0;
        for (const marble of marbles) {
          if (marble.done) continue;
          const at = marble.body.translation();
          if (record) marble.frames.push(at.x, at.y);
          if (at.y < layout.commitY) {
            let bin = binAt(layout, at.x);
            // Pressed into a wall's thickness by the solver: the nearer bin.
            if (bin < 0) bin = nearestBin(layout, at.x);
            if (!record) marble.frames.push(at.x, at.y);
            const velocity = marble.body.linvel();
            marble.fall = { drop: marble.drop, bin, frames: Float32Array.from(marble.frames), vx: velocity.x, vy: velocity.y };
            marble.done = true;
            open -= 1;
          }
        }
      }
      for (const marble of marbles) world.removeRigidBody(marble.body);
      return marbles.map((marble) => marble.fall);
    },
    dispose() {
      world.free();
    },
  };
}

function nearestBin(layout: BoardLayout, x: number): number {
  let best = 0;
  let distance = Infinity;
  for (const bin of layout.bins) {
    const d = Math.abs(bin.center - x);
    if (d < distance) {
      distance = d;
      best = bin.index;
    }
  }
  return best;
}
