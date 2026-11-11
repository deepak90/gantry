/**
 * What each person in a room is there to do, so that a crew reads as a crew at work and not as people moving at random.
 * Someone signals for the machine and looks up at it, some carry from the stock to the work and back, and the rest work
 * their way around what is being built, facing it. There are only so many motions to go around, and it is where people
 * stand and what they face that makes them read as these jobs.
 */
export interface Spot {
  x: number;
  y: number;
}

export type JobPose = 'hands' | 'stand' | 'wave';

export interface Stop extends Spot {
  /** How long they stay, in seconds. */
  hold: number;
  pose: JobPose;
  /** What they turn to face once they are there. */
  face?: Spot;
}

export interface RoomPlan {
  /** Where the work stands. */
  work: { x: number; y: number; w: number; d: number };
  /** Where what the work uses is piled. */
  stock: readonly Spot[];
  /** Where the machine stands, if there is one. */
  machine: Spot | null;
}

/** A point on the rectangle around the work, from 0 to 1 all the way around, a little out from its edge. */
function aroundWork(work: RoomPlan['work'], along: number): Spot {
  const [halfW, halfD] = [work.w / 2 + 8, work.d / 2 + 8];
  const edge = (halfW + halfD) * 2;
  let left = (((along % 1) + 1) % 1) * edge * 2;
  if (left < halfW * 2) return { x: work.x - halfW + left, y: work.y - halfD };
  left -= halfW * 2;
  if (left < halfD * 2) return { x: work.x + halfW, y: work.y - halfD + left };
  left -= halfD * 2;
  if (left < halfW * 2) return { x: work.x + halfW - left, y: work.y + halfD };
  left -= halfW * 2;
  return { x: work.x - halfW, y: work.y + halfD - left };
}

/** The point on the edge of the work nearest to somewhere, where something carried from there gets set down. */
function edgeNearest(work: RoomPlan['work'], from: Spot): Spot {
  return {
    x: Math.min(work.x + work.w / 2 + 6, Math.max(work.x - work.w / 2 - 6, from.x)),
    y: Math.min(work.y + work.d / 2 + 6, Math.max(work.y - work.d / 2 - 6, from.y)),
  };
}

/**
 * One list of stops for each person, in their order. Someone who can't walk gets one stop, at the work. A list of one
 * stop means they stay there.
 */
export function roomJobs(walks: readonly boolean[], plan: RoomPlan): Stop[][] {
  const center: Spot = { x: plan.work.x, y: plan.work.y };
  const walkers = walks.filter(Boolean).length;
  // Half of those who can walk carry, as long as there is something to carry.
  let carriers = plan.stock.length > 0 ? Math.ceil(Math.max(0, walkers - (plan.machine ? 1 : 0)) / 2) : 0;
  let signaler = plan.machine !== null && walkers > 0;
  let carried = 0;
  let fixers = 0;
  const fixing = walks.length - (signaler ? 1 : 0) - carriers;
  return walks.map((canWalk) => {
    if (canWalk && signaler && plan.machine) {
      signaler = false;
      const { machine } = plan;
      // Off to the side of the machine and looking at it, with a clear view of the load.
      const [dx, dy] = [center.x - machine.x, center.y - machine.y];
      const reach = Math.max(1, Math.hypot(dx, dy));
      return [{ x: machine.x + (dx / reach) * 34 - (dy / reach) * 22, y: machine.y + (dy / reach) * 34 + (dx / reach) * 22, hold: 30, pose: 'wave' as const, face: machine }];
    }
    if (canWalk && carriers > 0) {
      carriers -= 1;
      const stock = plan.stock[carried % plan.stock.length]!;
      carried += 1;
      const drop = edgeNearest(plan.work, stock);
      return [
        { ...stock, hold: 1.8 + (carried % 3) * 0.5, pose: 'hands' as const, face: stock },
        { ...drop, hold: 2.4 + (carried % 2) * 0.8, pose: 'hands' as const, face: center },
      ];
    }
    const along = (fixers + 0.5) / Math.max(1, fixing);
    fixers += 1;
    const here = aroundWork(plan.work, along);
    if (!canWalk) return [{ ...here, hold: 30, pose: 'hands' as const, face: center }];
    // Moves along the work now and then, to the next stretch of it.
    const next = aroundWork(plan.work, along + 0.07);
    return [
      { ...here, hold: 7 + (fixers % 3) * 2, pose: 'hands' as const, face: center },
      { ...next, hold: 6 + (fixers % 2) * 3, pose: 'hands' as const, face: center },
    ];
  });
}
