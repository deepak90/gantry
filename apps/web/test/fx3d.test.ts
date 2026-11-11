import type { TaskModel } from '@bryntum/gantt';
import { Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Plane, Ray, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { costLines, rowsByFirm, rowSoFar, rowTotal } from '../src/gantt/fx3d/cost-breakdown';
import { crewZones, standingSpots } from '../src/gantt/fx3d/crew-floor';
import { dayTiles, idleCostBy, rentalUse, spentWords, workDaysBegun, dayKey, dayWords, type DayTile } from '../src/gantt/fx3d/day-track';
import { roomJobs } from '../src/gantt/fx3d/room-jobs';
import { fitOnGround } from '../src/gantt/fx3d/props';
import { standSign } from '../src/gantt/fx3d/standing-models';
import { kitFor, machineKind, progressAt, reportedProgress, type TaskFacts, workDaysOf } from '../src/gantt/fx3d/facts';
import { bakeInto } from '../src/gantt/fx3d/kits';
import { colorOverChart, colorOverRoom, dropHeight, FALL_SPLIT, fallStage, fillHeight, overBar } from '../src/gantt/fx3d/fall';
import { firmLinks, labelsFor } from '../src/gantt/fx3d/flowline';
import { frontRoute } from '../src/gantt/fx3d/road-marker';
import type { LookState, Tracker } from '../src/gantt/look';
import { aimFrom, aroundPose, FOV, onTheJib, pageToWorld, placeCamera, poseOfCamera, restPose, turnPose } from '../src/gantt/fx3d/rig';
import { CRANE_AT, flyLean, FOOTPRINT, NEIGHBORS } from '../src/gantt/fx3d/building-site';
import { afterWeekdays, idleStretches, issuesOf, layoutRoad, payCheckOf, payCheckWords, payoutOf, roadRoute, slackDaysOf, startsTheDelay } from '../src/gantt/fx3d/site-facts';
import { overlaps, plateLevel, standingOf } from '../src/gantt/fx3d/plates';
import { createAmble } from '../src/gantt/fx3d/people';
import { type Scene, sceneToShow, stepsFrom, trailOf, upFrom, worksWithin } from '../src/gantt/fx3d/site-nav';
import { steppedOffset, stepFor, wheelAction } from '../src/gantt/fx3d/view-pad';

function cameraAt(width: number, height: number, pose = restPose(height)): PerspectiveCamera {
  const camera = new PerspectiveCamera(FOV, width / height, 10, 30_000);
  placeCamera(camera, pose);
  return camera;
}

describe('the camera', () => {
  it('starts one world unit to one CSS pixel over the page, so a bar can leave from where it was drawn', () => {
    const [width, height] = [1600, 1000];
    const camera = cameraAt(width, height);
    const seen = new Vector3(pageToWorld(640, 310, width, height).x, pageToWorld(640, 310, width, height).y, 0).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    expect(((seen.x + 1) / 2) * width).toBeCloseTo(640, 3);
    expect(((1 - seen.y) / 2) * height).toBeCloseTo(310, 3);
  });

  it('finds the pose back from where the controls left it', () => {
    const pose = { x: 120, y: -40, z: 60, azimuth: -0.6, elevation: 1.1, distance: 1300 };
    const camera = cameraAt(1600, 1000, pose);
    const found = poseOfCamera(camera.position, new Vector3(pose.x, pose.y, pose.z));
    expect(found.azimuth).toBeCloseTo(pose.azimuth, 6);
    expect(found.elevation).toBeCloseTo(pose.elevation, 6);
    expect(found.distance).toBeCloseTo(pose.distance, 6);
  });
});

describe('which model shows the work', () => {
  it.each([
    ['Excavate foundations', ['excavator'], 'earth'],
    ['Pour footings, east wing', ['pump'], 'concrete'],
    ['Erect steel frame', ['crane'], 'steel'],
    ['Exterior wall panels', ['lift'], 'envelope'],
    ['Site setup & fencing', [], 'site'],
    ['Paint', [], 'interior'],
    // No telling words: the machine decides.
    ['Second lift of the core', ['crane'], 'steel'],
  ] as const)('%s', (name, machines, kit) => {
    expect(kitFor(name, machines)).toBe(kit);
  });

  it('knows a machine by its name', () => {
    expect(machineKind('Scissor lift')).toBe('lift');
    expect(machineKind('Concrete pump')).toBe('pump');
    expect(machineKind('Generator')).toBeNull();
  });
});

describe('the site board', () => {
  const look = (canViewCosts: boolean) => ({ canViewCosts, currency: 'USD', decorations: new Map() }) as unknown as LookState;
  const task = (fields: object) => ({ id: 1, name: 'Paint', duration: 3, percentDone: 0, ...fields }) as unknown as TaskModel;
  const facts = { machine: null, start: new Date(2027, 0, 4), end: new Date(2027, 0, 9), rulerStart: new Date(2027, 0, 4) } as unknown as TaskFacts;

  const road = () =>
    layoutRoad([
      { key: 'excavate', group: 'site', start: 1, days: 4, idleDays: 0, before: [] },
      { key: 'east pour', group: 'site', start: 2, days: 3, idleDays: 0, before: ['excavate'] },
      { key: 'west pour', group: 'site', start: 3, days: 3, idleDays: 0, before: ['excavate'] },
      { key: 'cure', group: 'site', start: 4, days: 3, idleDays: 0, before: ['east pour', 'west pour'] },
      { key: 'erect', group: 'steel', start: 5, days: 6, idleDays: 3, before: ['cure'] },
      { key: 'bolt up', group: 'steel', start: 6, days: 2, idleDays: 0, before: ['erect'] },
    ]);

  it('stands work that runs at the same time side by side, and the next step further along', () => {
    const { plots } = road();
    const [east, west, excavate, cure] = [plots.get('east pour')!, plots.get('west pour')!, plots.get('excavate')!, plots.get('cure')!];
    expect(east.x).toBe(west.x);
    expect(east.y).not.toBe(west.y);
    expect(excavate.x).toBeLessThan(east.x);
    expect(east.x).toBeLessThan(cure.x);
  });

  it('gives each phase its own row, the road turning back on the next one', () => {
    const { plots, rows } = road();
    expect(rows).toHaveLength(2);
    expect(plots.get('excavate')!.dir).toBe(1);
    expect(plots.get('erect')!.dir).toBe(-1);
    expect(plots.get('bolt up')!.x).toBeLessThan(plots.get('erect')!.x);
  });

  it('leaves room for a machine paid for before its work', () => {
    expect(road().plots.get('erect')!.idleW).toBeGreaterThan(0);
    expect(road().plots.get('cure')!.idleW).toBe(0);
  });

  it('routes every step in right angles, from the end of one plot to the start of the next', () => {
    const { plots, width } = road();
    const pairs = [['excavate', 'east pour'], ['excavate', 'west pour'], ['west pour', 'cure'], ['cure', 'erect'], ['erect', 'bolt up'], ['excavate', 'bolt up']] as const;
    for (const [from, to] of pairs) {
      const [a, b] = [plots.get(from)!, plots.get(to)!];
      const route = roadRoute(a, b, width / 2 + 80);
      for (let index = 1; index < route.length; index++) {
        const [p, q] = [route[index - 1]!, route[index]!];
        expect(Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6).toBe(true);
      }
      expect(route[0]).toEqual({ x: a.x + (a.dir * a.w) / 2, y: a.y });
      expect(route.at(-1)).toEqual({ x: b.x - (b.dir * b.w) / 2, y: b.y });
    }
  });

  it('turns around the end of the block on its way to the next phase', () => {
    const { plots, width } = road();
    const route = roadRoute(plots.get('cure')!, plots.get('erect')!, width / 2 + 80);
    expect(Math.max(...route.map((point) => point.x))).toBe(width / 2 + 80);
  });

  it('raises money paid ahead of the work as an issue, only for those who may see money', () => {
    const ahead = task({ percentDone: 10, forecastMinor: 100_000, paidMinor: 40_000 });
    const facts = { name: 'Pour', machine: null, start: new Date(2027, 0, 4), end: new Date(2027, 0, 8) } as unknown as TaskFacts;
    expect(issuesOf(ahead, facts, look(true), []).map((issue) => issue.text)).toEqual(['Paid $300 ahead of the work reported']);
    expect(issuesOf(ahead, facts, look(false), [])).toEqual([]);
  });

  it('flags where lateness starts, not every task it reaches', () => {
    const baseline = (end: number) => ({ baselines: { first: { endDate: new Date(2027, 0, end) } } });
    const first = task({ id: 1, endDate: new Date(2027, 0, 12), ...baseline(10) });
    const next = task({ id: 2, endDate: new Date(2027, 0, 20), predecessors: [{ fromEvent: first }], ...baseline(18) });
    // Longer on the calendar because a weekend fell inside it, but still the same delay.
    const overWeekend = task({ id: 3, endDate: new Date(2027, 0, 25), predecessors: [{ fromEvent: next }], ...baseline(21) });
    expect(startsTheDelay(first)).toBe(true);
    expect(startsTheDelay(next)).toBe(false);
    expect(startsTheDelay(overWeekend)).toBe(false);
    expect(issuesOf(next, facts, look(true), [])).toEqual([]);
    expect(issuesOf(first, facts, look(true), [])[0]?.text).toBe('2 days late, and it starts here');
  });

  it('calls over budget only for viewers who may see money', () => {
    const over = task({ budgetMinor: 100_000, forecastMinor: 130_000 });
    expect(issuesOf(over, facts, look(true), []).map((issue) => issue.text)).toEqual(['$300 over budget']);
    expect(issuesOf(over, facts, look(false), [])).toEqual([]);
  });

  it('names a machine booked twice, and says nothing about finished work', () => {
    expect(issuesOf(task({}), facts, look(true), [{ crew: 'Concrete pump', days: 2, from: 0, to: 1 }])[0]?.text).toBe('Concrete pump booked twice, 2 days');
    const idle = { ...facts, machine: 'Crane' } as unknown as TaskFacts;
    const tiles: DayTile[] = [{ at: new Date(2027, 0, 1).getTime(), kind: 'idle', costMinor: 60_000 }];
    expect(issuesOf(task({ percentDone: 100 }), idle, look(true), [], tiles)).toEqual([]);
  });

  it('counts a machine with no work as idle on either side of the work, and says which', () => {
    const on = (date: number): number => new Date(2027, 0, date).getTime();
    const tile = (date: number, kind: DayTile['kind'], costMinor = 0): DayTile => ({ at: on(date), kind, costMinor });
    const tiles = [tile(1, 'idle', 60_000), tile(2, 'off'), tile(3, 'off'), tile(4, 'work'), tile(5, 'work'), tile(11, 'idle', 60_000), tile(12, 'idle', 60_000)];
    expect(idleStretches(tiles, on(4))).toEqual([
      { side: 'before', days: 1, costMinor: 60_000, from: on(1), to: on(1) + 86_400_000 },
      { side: 'after', days: 2, costMinor: 120_000, from: on(11), to: on(12) + 86_400_000 },
    ]);
    const idle = { ...facts, machine: 'Crane' } as unknown as TaskFacts;
    expect(issuesOf(task({}), idle, look(true), [], tiles).map((issue) => issue.text)).toEqual(['Crane: 1 idle day before the work, \u2212$600', 'Crane: 2 idle days after the work, \u2212$1,200']);
    expect(idleStretches([tile(4, 'work')], on(4))).toEqual([]);
  });

  it('counts working days, so a weekend is not a day of the work', () => {
    const [start, end] = [new Date(2027, 0, 21), new Date(2027, 0, 26)];
    const weekdays = { isWorkingTime: (day: Date) => day.getDay() !== 0 && day.getDay() !== 6 };
    const workDays = workDaysOf(start, end, weekdays);
    expect(workDays).toHaveLength(3);
    const facts = { workDays, percent: 0, start, end };
    const at = (day: number) => new Date(2027, 0, day, 12).getTime();
    const before = new Date(2020, 0, 1).getTime();
    expect(progressAt(facts, at(20), before)).toMatchObject({ state: 'ahead', built: 0 });
    expect(progressAt(facts, at(21), before)).toMatchObject({ state: 'active', day: 1, of: 3 });
    expect(progressAt(facts, at(23), before)).toMatchObject({ state: 'active', day: 0 });
    expect(progressAt(facts, at(25), before)).toMatchObject({ state: 'active', day: 3 });
    expect(progressAt(facts, at(26), before)).toMatchObject({ state: 'done', built: 1 });
  });

  it('counts what has really been reported, from today on', () => {
    const [start, end] = [new Date(2027, 0, 4), new Date(2027, 0, 9)];
    const facts = { workDays: workDaysOf(start, end), percent: 60, start, end };
    const today = new Date(2027, 0, 5).getTime();
    expect(progressAt(facts, today, today).built).toBeCloseTo(0.6);
    expect(progressAt(facts, new Date(2027, 0, 4, 12).getTime(), today).built).toBeCloseTo(0.1);
  });

  it('runs a double booking over weekdays only', () => {
    expect(new Date(afterWeekdays('2027-01-21', 2)).getDate()).toBe(23);
    expect(new Date(afterWeekdays('2027-01-22', 2)).getDate()).toBe(26);
  });

  it('reads where a payment stands at PayPal', () => {
    const tracker = (state: string, fields: object = {}) => ({ steps: [{ key: 'paid', state, status: 'Paid' }], dropped: false, paying: false, amountMinor: 50_000, ...fields }) as unknown as Tracker;
    expect(payoutOf(null).state).toBe('none');
    expect(payoutOf(tracker('done')).state).toBe('paid');
    expect(payoutOf(tracker('current')).state).toBe('ready');
    expect(payoutOf(tracker('current', { paying: true })).state).toBe('moving');
    expect(payoutOf(tracker('failed')).state).toBe('failed');
    expect(payoutOf(tracker('done', { dropped: true })).state).toBe('none');
  });
});

describe('where a person can go', () => {
  const plan = { order: ['dig', 'pour', 'erect'], name: (work: string) => work };
  const scenes: Scene<string>[] = [{ kind: 'chart' }, { kind: 'board' }, ...plan.order.map((work) => ({ kind: 'work' as const, work }))];

  it('has no dead ends: every scene offers a way on', () => {
    for (const scene of scenes) expect(stepsFrom(scene, plan).length).toBeGreaterThan(0);
  });

  it('gets back to the chart from anywhere, one level at a time', () => {
    for (const scene of scenes) {
      let at: Scene<string> | null = scene;
      let hops = 0;
      while (at && at.kind !== 'chart' && hops < 5) {
        at = upFrom(at);
        hops += 1;
      }
      expect(at).toEqual({ kind: 'chart' });
    }
  });

  it('can reach every piece of work from the chart', () => {
    const seen = new Set<string>();
    const visit = (scene: Scene<string>): void => {
      const key = JSON.stringify(scene);
      if (seen.has(key)) return;
      seen.add(key);
      for (const step of stepsFrom(scene, plan)) visit(step.to);
    };
    visit({ kind: 'chart' });
    for (const scene of scenes) expect(seen.has(JSON.stringify(scene))).toBe(true);
  });

  it('walks the work in road order, and the end of the walk leads back to the board', () => {
    const next = (work: string) => stepsFrom<string>({ kind: 'work', work }, plan).find((step) => step.role === 'next')?.to;
    expect(next('dig')).toEqual({ kind: 'work', work: 'pour' });
    expect(next('erect')).toEqual({ kind: 'board' });
    expect(stepsFrom<string>({ kind: 'work', work: 'dig' }, plan).some((step) => step.role === 'previous')).toBe(false);
    expect(stepsFrom<string>({ kind: 'work', work: 'pour' }, plan).find((step) => step.role === 'previous')?.to).toEqual({ kind: 'work', work: 'dig' });
  });

  it('says where you are, with a way back at each level above', () => {
    const trail = trailOf<string>({ kind: 'work', work: 'pour' }, plan);
    expect(trail.map((part) => part.label)).toEqual(['Chart', 'Site board', 'pour']);
    expect(trail.at(-1)?.to).toBeNull();
    expect(trail[1]?.to).toEqual({ kind: 'board' });
  });
});

describe('being shown tasks from outside the scene', () => {
  it('walks into one piece of work, and shows several together on the board', () => {
    expect(sceneToShow(['crane'])).toEqual({ kind: 'work', work: 'crane' });
    expect(sceneToShow(['east', 'west'])).toEqual({ kind: 'board' });
  });

  it('stays where it is with nothing to show', () => {
    expect(sceneToShow([])).toBeNull();
  });

  const job = (name: string) => ({ name, work: true, children: null as unknown });
  const phase = (name: string, children: unknown[]) => ({ name, work: false, children });

  it('takes a phase for all the work inside it, once each and in order', () => {
    const [a, b, c] = [job('a'), job('b'), job('c')];
    const inner = phase('inner', [b]);
    const outer = phase('outer', [a, inner, c]);
    expect(worksWithin([outer, b], (item) => item.work)).toEqual([a, b, c]);
  });

  it('leaves out what has no work to show, like a milestone', () => {
    const milestone = { name: 'handover', work: false, children: null };
    expect(worksWithin([milestone], (item) => item.work)).toEqual([]);
  });
});

describe('the crane ride and the fly-around', () => {
  // The film's window: 1600 by 900, less the app's header. With the side panel open (as on the call) the room left for
  // the scene has its middle left of the canvas's, and up, clear of the call and the controls under it.
  const [width, height] = [1600, 852];
  const lens = { fov: FOV, aspect: width / height };
  const spots = [
    { x: 0, y: 0 },
    { x: -0.285, y: 0.164 },
  ];
  const mast = new Vector3(CRANE_AT.x, CRANE_AT.y, 0);
  const jib = { height: 330, reach: 400 };
  const work = new Vector3((FOOTPRINT.x0 + FOOTPRINT.x1) / 2, (FOOTPRINT.y0 + FOOTPRINT.y1) / 2, 0);
  const overWork = Math.atan2(work.y - mast.y, work.x - mast.x);
  const neighbors = NEIGHBORS.map(([x0, y0, x1, y1, tall]) => new Box3(new Vector3(x0, y0, 0), new Vector3(x1, y1, tall)));
  const ground = new Plane(new Vector3(0, 0, 1), 0);
  const inFrame = (camera: PerspectiveCamera, at: Vector3) => {
    const seen = at.clone().project(camera);
    return Math.abs(seen.x) < 1 && Math.abs(seen.y) < 1 && seen.z < 1;
  };
  /** What a ray through this spot in the frame meets first: the ground (where), or a neighbor. */
  const firstHit = (camera: PerspectiveCamera, x: number, y: number) => {
    const ray = new Ray(camera.position.clone(), new Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize());
    const down = ray.intersectPlane(ground, new Vector3());
    const toGround = down ? ray.origin.distanceTo(down) : Infinity;
    const wall = neighbors.some((block) => {
      const hit = ray.intersectBox(block, new Vector3());
      return hit !== null && ray.origin.distanceTo(hit) < toGround - 1e-6;
    });
    return { down, wall };
  };

  it('aims from where it is told to stand, with what the shot is about at the spot asked for', () => {
    const eye = new Vector3(168, -124, 420);
    const at = new Vector3(-99, 30, 50);
    for (const spot of spots) {
      const camera = cameraAt(width, height, aimFrom(eye, at, spot, lens));
      expect(camera.position.distanceTo(eye)).toBeLessThan(1e-6);
      const seen = at.clone().project(camera);
      expect(seen.x).toBeCloseTo(spot.x, 4);
      expect(seen.y).toBeCloseTo(spot.y, 4);
    }
  });

  it('rides out past the tip of the jib and looks back down at the lot: the hook, the mast\'s foot and its days in the frame, no neighbor in the middle of it', () => {
    const { eye, look } = onTheJib(mast, overWork, jib);
    expect(Math.hypot(eye.x - mast.x, eye.y - mast.y)).toBeGreaterThan(jib.reach);
    expect(eye.z).toBeGreaterThan(jib.height + 40);
    const hook = work.clone().setZ(150);
    const days = new Vector3(-222, -20, 0);
    for (const spot of spots) {
      const camera = cameraAt(width, height, aimFrom(eye, look, spot, lens));
      for (const shown of [hook, mast, days]) expect(inFrame(camera, shown)).toBe(true);
      // The middle of the frame, what the shot is about, comes down on the ground the site stands on, never on a
      // neighbor: they keep to its top edge, far off behind the crane.
      for (let x = spot.x - 0.5; x <= spot.x + 0.5 + 1e-9; x += 0.1) {
        for (let y = spot.y - 0.3; y <= spot.y + 0.3 + 1e-9; y += 0.1) {
          const { down, wall } = firstHit(camera, x, y);
          expect(wall).toBe(false);
          expect(down).not.toBeNull();
          expect(down!.x).toBeGreaterThan(-420);
          expect(down!.x).toBeLessThan(450);
          expect(down!.y).toBeGreaterThan(-410);
          expect(down!.y).toBeLessThan(340);
        }
      }
    }
  });

  it('turns the camera with the jib, about the mast, so what rides with it stays put in the frame', () => {
    const { eye, look } = onTheJib(mast, overWork, jib);
    const pose = aimFrom(eye, look, spots[1]!, lens);
    const turned = cameraAt(width, height, turnPose(pose, mast, 0.02));
    const turn = (at: Vector3) => at.clone().sub(mast).applyAxisAngle(new Vector3(0, 0, 1), 0.02).add(mast);
    expect(turned.position.distanceTo(turn(eye))).toBeLessThan(1e-6);
    const seen = turn(look).project(turned);
    expect(seen.x).toBeCloseTo(spots[1]!.x, 4);
    expect(seen.y).toBeCloseTo(spots[1]!.y, 4);
  });

  it('flies round with the middle of the building at the middle of the room, and no neighbor ever in front of the building\'s foot', () => {
    const center = new Vector3(0, 0, 130);
    const foot = [0, 0.25, 0.5, 0.75, 1].flatMap((t) => [
      new Vector3(FOOTPRINT.x0 + (FOOTPRINT.x1 - FOOTPRINT.x0) * t, FOOTPRINT.y0, 0),
      new Vector3(FOOTPRINT.x0 + (FOOTPRINT.x1 - FOOTPRINT.x0) * t, FOOTPRINT.y1, 0),
      new Vector3(FOOTPRINT.x0, FOOTPRINT.y0 + (FOOTPRINT.y1 - FOOTPRINT.y0) * t, 0),
      new Vector3(FOOTPRINT.x1, FOOTPRINT.y0 + (FOOTPRINT.y1 - FOOTPRINT.y0) * t, 0),
    ]);
    const hiddenFrom = (camera: PerspectiveCamera, at: Vector3) => {
      const ray = new Ray(camera.position.clone(), at.clone().sub(camera.position).normalize());
      const far = camera.position.distanceTo(at);
      return neighbors.some((block) => {
        const hit = ray.intersectBox(block, new Vector3());
        return hit !== null && ray.origin.distanceTo(hit) < far - 1e-3;
      });
    };
    for (const [spot, distance] of spots.flatMap((spot) => [1600, 2400].map((distance) => [spot, distance] as const))) {
      for (let turn = 0; turn < 24; turn++) {
        const azimuth = (turn * Math.PI) / 12;
        const camera = cameraAt(width, height, aroundPose(center, azimuth, flyLean(azimuth), distance, spot, lens));
        const seen = center.clone().project(camera);
        expect(seen.x).toBeCloseTo(spot.x, 5);
        expect(seen.y).toBeCloseTo(spot.y, 5);
        expect(neighbors.some((block) => block.containsPoint(camera.position))).toBe(false);
        expect(foot.filter((at) => hiddenFrom(camera, at))).toEqual([]);
      }
    }
  });
});

describe('moving the view', () => {
  const wheel = (deltaY: number, extra: Partial<{ deltaX: number; deltaMode: number; ctrlKey: boolean }> = {}) => ({ deltaX: 0, deltaMode: 0, ctrlKey: false, deltaY, ...extra });

  it('zooms on a pinch, and on a mouse wheel whether it reports big notches or a Mac\'s small ones', () => {
    expect(wheelAction(wheel(-3, { ctrlKey: true }), null, 0).action).toBe('zoom');
    expect(wheelAction(wheel(100), null, 0).action).toBe('zoom');
    expect(wheelAction(wheel(-4.000244140625), null, 0).action).toBe('zoom');
    expect(wheelAction(wheel(-8.00048828125), null, 0).action).toBe('zoom');
    expect(wheelAction(wheel(3, { deltaMode: 1 }), null, 0).action).toBe('zoom');
  });

  it('moves on two trackpad fingers, even when a flick grows as large as a wheel notch', () => {
    const start = wheelAction(wheel(3), null, 0);
    expect(start.action).toBe('move');
    expect(wheelAction(wheel(140), start, 100).action).toBe('move');
    expect(wheelAction(wheel(2, { deltaX: 5 }), null, 0).action).toBe('move');
    // A new gesture is judged afresh.
    expect(wheelAction(wheel(120), start, 1000).action).toBe('zoom');
  });

  const limits = { minPolar: 0.12, maxPolar: 1.42, minDistance: 100, maxDistance: 1000 };

  it('turns around the target, keeping its distance and height', () => {
    const offset = { x: 0, y: -500, z: 500 };
    const turned = steppedOffset(offset, { turn: Math.PI / 2 }, limits);
    expect(Math.hypot(turned.x, turned.y, turned.z)).toBeCloseTo(Math.hypot(500, 500), 6);
    expect(turned.z).toBeCloseTo(500, 6);
    expect(turned.x).toBeCloseTo(500, 6);
  });

  it('stays within the limits for tilt and distance', () => {
    const offset = { x: 0, y: -500, z: 500 };
    expect(Math.acos(steppedOffset(offset, { tilt: 5 }, limits).z / Math.hypot(500, 500))).toBeCloseTo(1.42, 6);
    expect(Math.acos(steppedOffset(offset, { tilt: -5 }, limits).z / Math.hypot(500, 500))).toBeCloseTo(0.12, 6);
    const near = steppedOffset(offset, { zoom: 0.001 }, limits);
    expect(Math.hypot(near.x, near.y, near.z)).toBeCloseTo(100, 6);
  });

  it('gives each held button a direction', () => {
    expect(stepFor('zoom-in', 0.1).zoom).toBeLessThan(1);
    expect(stepFor('zoom-out', 0.1).zoom).toBeGreaterThan(1);
    expect(stepFor('tilt-down', 0.1).tilt).toBeGreaterThan(0);
    expect(stepFor('tilt-up', 0.1).tilt).toBeLessThan(0);
  });
});

describe('the days of a piece of work', () => {
  // A crane on rent from Mon Feb 1; the work runs Mon Feb 8 to Mon Feb 15, and the rental until Wed Feb 17.
  const facts = {
    rulerStart: new Date(2027, 1, 1),
    rulerEnd: new Date(2027, 1, 17),
    start: new Date(2027, 1, 8),
    end: new Date(2027, 1, 16),
    workDays: [8, 9, 10, 11, 12, 15].map((day) => new Date(2027, 1, day).getTime()),
    rentedDays: Array.from({ length: 16 }, (_, index) => new Date(2027, 1, index + 1).getTime()),
  };
  const tiles = dayTiles(facts, 60_000);

  it('has one tile for every calendar day: a weekend on rent is idle outside the work and paid inside it', () => {
    expect(tiles).toHaveLength(16);
    expect(tiles.map((tile) => tile.kind)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'work', 'work', 'work', 'work', 'work', 'paid', 'paid', 'work', 'idle']);
  });

  it('costs the rate on each day on rent with no work, and nothing on a day of work', () => {
    expect(tiles.filter((tile) => tile.kind === 'idle')).toHaveLength(8);
    expect(tiles.filter((tile) => tile.kind !== 'work').every((tile) => tile.costMinor === 60_000)).toBe(true);
    expect(tiles.filter((tile) => tile.kind === 'work').every((tile) => tile.costMinor === 0)).toBe(true);
  });

  it('adds up the cost by whole days, and reaches the total on the last idle day however late in it the date is', () => {
    const day = (date: number, hour = 0) => new Date(2027, 1, date, hour).getTime();
    expect(idleCostBy(tiles, day(0))).toBe(0);
    expect(idleCostBy(tiles, day(1))).toBe(60_000);
    expect(idleCostBy(tiles, day(3, 12))).toBe(180_000);
    expect(idleCostBy(tiles, day(7))).toBe(420_000);
    // The paid weekend inside the work is not idle money.
    expect(idleCostBy(tiles, day(15))).toBe(420_000);
    expect(idleCostBy(tiles, day(16))).toBe(480_000);
    expect(idleCostBy(tiles, day(16, 23))).toBe(480_000);
    expect(idleCostBy(tiles, day(20))).toBe(480_000);
  });

  it('says a day off inside the work is still paid for', () => {
    const sunday = tiles.find((tile) => tile.at === new Date(2027, 1, 14).getTime())!;
    expect(dayWords(sunday, tiles, 'Crane', () => '$600')).toBe('Sun, Feb 14: crew off, Crane still booked, \u2212$600');
  });

  it('with no machine on rent, a day off inside the work is only a day off', () => {
    const noMachine = dayTiles({ ...facts, rulerStart: facts.start, rulerEnd: facts.end, rentedDays: [] }, 0);
    expect(noMachine.filter((tile) => tile.kind !== 'work').map((tile) => tile.kind)).toEqual(['off', 'off']);
  });

  it('says how much of a rental is in use', () => {
    const use = rentalUse(tiles);
    expect(use).toMatchObject({ idle: 8, work: 6, paid: 2, booked: 16 });
    expect(use.share).toBeCloseTo(6 / 16, 6);
  });

  it('shows no money to someone who may not see it, and still counts the days', () => {
    const blind = dayTiles(facts, 0);
    expect(blind.every((tile) => tile.costMinor === 0)).toBe(true);
    expect(rentalUse(blind).idle).toBe(8);
    expect(idleCostBy(blind, new Date(2027, 1, 10).getTime())).toBe(0);
  });

  it('says money going out with a true minus sign, so it cannot be read as money saved', () => {
    expect(spentWords('$600')).toBe('\u2212$600');
  });

  it('with no rental around it, is only the days of the work', () => {
    const plain = dayTiles({ ...facts, rulerStart: facts.start, rulerEnd: facts.end }, 0);
    expect(plain.some((tile) => tile.kind === 'idle')).toBe(false);
    expect(plain[0]?.at).toBe(facts.start.getTime());
  });
});

describe('the labels on the board', () => {
  it('say more as the board gets larger on the screen', () => {
    expect(plateLevel(0.6)).toBe(0);
    expect(plateLevel(1)).toBe(1);
    expect(plateLevel(2)).toBe(2);
  });

  it('say where the work stands on the date', () => {
    const [start, end] = [new Date(2027, 1, 8).getTime(), new Date(2027, 1, 16).getTime()];
    expect(standingOf({ state: 'active', built: 0.5, day: 3, of: 6 }, start, end, start)).toBe('Planned day 3 of 6');
    expect(standingOf({ state: 'active', built: 0.5, day: 0, of: 6 }, start, end, start)).toBe('Planned day off');
    expect(standingOf({ state: 'ahead', built: 0, day: 0, of: 6 }, start, end, new Date(2027, 1, 1).getTime())).toBe('Planned to start in 7 days');
    expect(standingOf({ state: 'ahead', built: 0, day: 0, of: 6 }, start, end, start - 3_600_000)).toBe('Planned to start tomorrow');
    expect(standingOf({ state: 'done', built: 1, day: 0, of: 6 }, start, end, end)).toBe('Planned to be done');
    // Done ahead of its dates: only a report can say that.
    expect(standingOf({ state: 'done', built: 1, day: 0, of: 6 }, start, end, start)).toBe('Reported finished early');
  });

  it('know when they would land on each other', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(overlaps(box, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(overlaps(box, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe('falling into a bar', () => {
  it('starts exactly over the chart and goes through it', () => {
    expect(dropHeight(0, 1866)).toBe(1866);
    expect(dropHeight(1, 1866, 90)).toBe(-90);
    // As anything falling does: slowly at first, then fast.
    expect(1866 - dropHeight(0.25, 1866)).toBeLessThan(dropHeight(0.75, 1866) - dropHeight(1, 1866));
  });

  it('is over the bar before it reaches it', () => {
    const crossing = (1866 / (1866 + 90)) ** (1 / 3);
    expect(overBar(0)).toBe(0);
    expect(overBar(crossing)).toBe(1);
  });

  it('goes from the chart to the room behind the bar\'s color, in both directions', () => {
    expect(fallStage(FALL_SPLIT - 0.001).stage).toBe('chart');
    expect(fallStage(FALL_SPLIT).stage).toBe('room');
    const fill = fillHeight({ w: 270, d: 30 }, Math.tan((30 * Math.PI) / 360), 1.6);
    expect(colorOverChart(1866, fill)).toBe(0);
    expect(colorOverChart(fill, fill)).toBe(1);
    expect(colorOverRoom(0)).toBe(1);
    expect(colorOverRoom(1)).toBe(0);
  });
});

describe('the work front', () => {
  const day = 86_400_000;
  const stop = (fromX: number, toX: number, start: number, end: number, road: { x: number; y: number }[] = []) => ({ road, along: [{ x: fromX, y: 0 }, { x: toX, y: 0 }], start: start * day, end: end * day });

  it('drives across a plot while its work is on, and waits at each end of the plan', () => {
    const route = frontRoute([stop(0, 100, 10, 20)]);
    expect(route.at(5 * day).x).toBe(0);
    expect(route.at(15 * day).x).toBeCloseTo(50, 6);
    expect(route.at(30 * day).x).toBe(100);
  });

  it('takes the road between plots, reaching the next as its work starts', () => {
    const route = frontRoute([stop(0, 100, 10, 20), stop(200, 300, 30, 40, [{ x: 100, y: 0 }, { x: 200, y: 0 }])]);
    expect(route.at(30 * day).x).toBeCloseTo(200, 6);
    const onTheRoad = route.at(30 * day - 0.3 * day).x;
    expect(onTheRoad).toBeGreaterThan(100);
    expect(onTheRoad).toBeLessThan(200);
  });

  it('never goes back in time or jumps, even when the work overlaps', () => {
    const route = frontRoute([stop(0, 100, 10, 30), stop(200, 300, 15, 25, [{ x: 100, y: 0 }, { x: 200, y: 0 }]), stop(400, 500, 26, 28, [{ x: 300, y: 0 }, { x: 400, y: 0 }])]);
    for (let index = 1; index < route.legs.length; index++) {
      const [before, leg] = [route.legs[index - 1]!, route.legs[index]!];
      expect(leg.fromAt).toBeGreaterThanOrEqual(before.toAt - 1e-6);
      expect(leg.toAt).toBeGreaterThanOrEqual(leg.fromAt);
      expect(leg.from).toEqual(before.to);
    }
    let last = -Infinity;
    for (let at = 8 * day; at < 40 * day; at += day / 4) {
      const { x } = route.at(at);
      expect(x).toBeGreaterThanOrEqual(last - 1e-6);
      last = x;
    }
  });
});

describe('the flowline', () => {
  const work = (crew: string, start: number, label = 'A long name for a job', end = start + 5, row = 0, code = '1.1') => ({ crew, start, end, row, label, code });

  it('follows each firm from job to job in order, and ignores work with no firm', () => {
    const [a, b, c, d] = [work('North', 20), work('North', 5), work('South', 8), work('', 2)];
    const links = firmLinks([a, b, c, d]);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual([b, a]);
  });

  it('prints a name where it fits, and only the number where it would run into the next line', () => {
    const [near, nextToIt, last] = [work('N', 0, 'Pour footings', 10, 0, '1.3'), work('N', 0, 'Cure and backfill', 12, 0, '1.4'), work('N', 0, 'Cure', 100, 0, '1.5')];
    const labels = labelsFor([near, nextToIt, last], (at) => at * 10, 2000);
    expect(labels.get(near)).toBe('1.3');
    expect(labels.get(nextToIt)).toBe('Cure and backfill');
    expect(labels.get(last)).toBe('Cure');
  });
});

describe('slack', () => {
  const task = (fields: object) => ({ project: {}, ...fields }) as unknown as TaskModel;

  it('reads the engine\'s total slack, in days', () => {
    expect(slackDaysOf(task({ totalSlack: 3, slackUnit: 'day' }))).toBe(3);
    expect(slackDaysOf(task({ totalSlack: 16, slackUnit: 'hour' }))).toBe(2);
    expect(slackDaysOf(task({ totalSlack: 1, slackUnit: 'week' }))).toBe(5);
  });

  it('is nothing on critical work, or when the engine has no answer', () => {
    expect(slackDaysOf(task({ totalSlack: 0 }))).toBe(0);
    expect(slackDaysOf(task({ totalSlack: null }))).toBe(0);
    expect(slackDaysOf(task({}))).toBe(0);
  });
});

describe('a standing model', () => {
  it('stands a model on its base at the height asked, centered, with all its parts moved as one', () => {
    // As it comes: up along y and facing +z, away from the origin, in two parts.
    const body = new BoxGeometry(4, 10, 1).translate(50, 80, 3);
    const bar = new BoxGeometry(1, 14, 1).translate(50, 80, 3);
    standSign([body, bar], 28);
    const box = new Box3().setFromBufferAttribute(body.getAttribute('position') as never).union(new Box3().setFromBufferAttribute(bar.getAttribute('position') as never));
    expect(box.min.z).toBeCloseTo(0, 6);
    expect(box.max.z).toBeCloseTo(28, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
    expect((box.min.y + box.max.y) / 2).toBeCloseTo(0, 6);
    // Width stays in proportion: the tallest part sets the scale.
    expect(box.max.x - box.min.x).toBeCloseTo(8, 6);
    // What faced +z now faces -y, toward a camera at azimuth 0, so the S does not read backward.
    const front = new BoxGeometry(1, 1, 1).translate(0, 0, 5);
    const back = new BoxGeometry(1, 1, 1).translate(0, 0, -5);
    standSign([front, back], 11);
    front.computeBoundingBox();
    back.computeBoundingBox();
    expect(front.boundingBox!.min.y).toBeLessThan(back.boundingBox!.min.y);
  });
});

describe('where the money goes', () => {
  const day = (date: number, kind: DayTile['kind']) => ({ at: new Date(2027, 1, date).getTime(), kind, costMinor: 0 });
  // Five idle days, six of work, at $600 a day, on a job of $41,000.
  const days = [1, 2, 3, 4, 5].map((date) => day(date, 'idle')).concat([6, 7].map((date) => day(date, 'off')), [8, 9, 10, 11, 12, 15].map((date) => day(date, 'work')));
  const base = { forecastMinor: 4_100_000, days, idleColor: 'amber', unassigned: 'No crew yet', unassignedColor: 'gray' };
  const crane = { name: 'Crane', color: 'olive', rateMinor: 60_000 };
  const steel = { name: 'Summit Steel', color: 'blue', people: 8 };

  it('takes the machine out of the forecast at its rate, working and idle apart, and the crew gets the rest', () => {
    const lines = costLines({ ...base, crews: [steel], machine: crane });
    expect(lines.map((line) => [line.who, line.kind, line.minor])).toEqual([
      ['Summit Steel', 'crew', 3_440_000],
      ['Crane', 'machine', 360_000],
      ['Crane', 'idle', 300_000],
    ]);
    expect(lines.reduce((sum, line) => sum + line.minor, 0)).toBe(base.forecastMinor);
  });

  it('shares what crews get by how many people each has there', () => {
    const lines = costLines({ ...base, days: [], crews: [{ name: 'A', color: 'a', people: 3 }, { name: 'B', color: 'b', people: 1 }], machine: null });
    expect(lines.map((line) => line.minor)).toEqual([3_075_000, 1_025_000]);
  });

  it('says so when no crew is on the job, and never goes below nothing if the machine costs more than the forecast', () => {
    expect(costLines({ ...base, days: [], crews: [], machine: null }).map((line) => line.who)).toEqual(['No crew yet']);
    const lines = costLines({ ...base, forecastMinor: 100, crews: [steel], machine: crane });
    expect(lines.map((line) => line.kind)).toEqual(['machine', 'idle']);
  });

  it('adds a firm up across its jobs, most first, each job a segment', () => {
    const line = (who: string, minor: number) => ({ who, kind: 'crew' as const, color: 'c', minor });
    const rows = rowsByFirm([
      { work: 'erect', title: 'Erect', lines: [line('Steel', 300), line('Crane', 100)], share: () => 0.5 },
      { work: 'bolt', title: 'Bolt up', lines: [line('Steel', 100)], share: () => 0 },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['Steel', 'Crane']);
    expect(rows[0]!.segments.map((segment) => segment.key)).toEqual(['erect', 'bolt']);
    expect(rowTotal(rows[0]!)).toBe(400);
    expect(rowSoFar(rows[0]!)).toBe(150);
  });
});

describe('who stands where', () => {
  it('shares the floor by headcount, edge to edge, in the plan\'s order', () => {
    const zones = crewZones([6, 2], 400, 50);
    expect(zones[0]!.w).toBeGreaterThan(zones[1]!.w);
    expect(zones[0]!.w + zones[1]!.w).toBeCloseTo(400, 6);
    expect(zones[0]!.x - zones[0]!.w / 2).toBeCloseTo(-200, 6);
    expect(zones[1]!.x + zones[1]!.w / 2).toBeCloseTo(200, 6);
  });

  it('leaves each firm room for its logo, and copes when there is not enough', () => {
    expect(crewZones([20, 1], 400, 100)[1]!.w).toBeGreaterThanOrEqual(100);
    const tight = crewZones([1, 1, 1], 90, 100);
    expect(tight.reduce((sum, zone) => sum + zone.w, 0)).toBeCloseTo(90, 6);
  });

  it('stands exactly that many people, all inside the area, none on the same spot', () => {
    const area = { x: 10, y: -20, w: 120, d: 60 };
    for (const count of [1, 2, 4, 7, 8, 10]) {
      const spots = standingSpots(count, area);
      expect(spots).toHaveLength(count);
      expect(new Set(spots.map((spot) => `${spot.x},${spot.y}`)).size).toBe(count);
      for (const spot of spots) {
        expect(Math.abs(spot.x - area.x)).toBeLessThanOrEqual(area.w / 2);
        expect(Math.abs(spot.y - area.y)).toBeLessThanOrEqual(area.d / 2);
      }
    }
    expect(standingSpots(0, area)).toEqual([]);
  });
});

describe('someone ambling on site', () => {
  const area = { x: 0, y: 0, w: 200, d: 120 };
  const watch = (seed: number) => {
    const state = { pose: 'none' as string };
    const amble = createAmble(seed, (pose) => {
      state.pose = pose;
    });
    return { state, amble, at: { x: 10, y: -10, heading: 1 } };
  };
  /** Runs them for a while, and fails if they ever change place while not in the walk clip. */
  const run = ({ state, amble, at }: ReturnType<typeof watch>, seconds: number) => {
    let walked = 0;
    for (let time = 0; time < seconds; time += 1 / 30) {
      const [x, y] = [at.x, at.y];
      amble.step(1 / 30, at, 21);
      if (at.x !== x || at.y !== y) {
        expect(state.pose).toBe('walk');
        walked += 1;
      }
    }
    return walked;
  };

  it('only ever moves in the walk clip, and does walk', () => {
    for (const seed of [0.2, 1.4, 3.1, 7.7, 12.9]) {
      const person = watch(seed);
      person.amble.begin(area);
      person.amble.setOnSite(true);
      expect(run(person, 60)).toBeGreaterThan(0);
    }
  });

  it('coming on site part way through a walk does not slide them in their standing pose', () => {
    for (const seed of [0.2, 1.4, 3.1, 7.7, 12.9]) {
      const person = watch(seed);
      person.amble.begin(area);
      person.amble.setOnSite(false);
      expect(person.state.pose).toBe('stand');
      person.amble.setOnSite(true);
      run(person, 20);
    }
  });

  it('stays put and stands while off site, whatever they were doing', () => {
    const person = watch(1.4);
    person.amble.begin(area);
    person.amble.setOnSite(true);
    run(person, 10);
    person.amble.setOnSite(false);
    const [x, y] = [person.at.x, person.at.y];
    expect(run(person, 10)).toBe(0);
    expect([person.at.x, person.at.y, person.state.pose]).toEqual([x, y, 'stand']);
  });

  it('does not walk on the spot while off site, wherever they are put', () => {
    for (const seed of [0.2, 1.4, 3.1, 7.7, 12.9]) {
      const person = watch(seed);
      person.amble.begin(area);
      expect(person.state.pose).toBe('stand');
    }
  });

  it('being placed stops a walk in its tracks', () => {
    const person = watch(1.4);
    person.amble.begin(area);
    person.amble.setOnSite(true);
    person.amble.stopAt({ x: 50, y: 50, w: 20, d: 20 });
    expect(person.state.pose).not.toBe('walk');
    run(person, 20);
  });
});

describe('a model baked into one mesh', () => {
  const material = new MeshBasicMaterial();
  const boxOf = (mesh: Mesh) => new Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as never);

  it('keeps every part where it was, in the model\'s own space, whatever the model itself is scaled by', () => {
    const root = new Group();
    root.scale.setScalar(0.42);
    root.position.set(500, 500, 0);
    const part = new Mesh(new BoxGeometry(2, 2, 2));
    part.position.set(10, 0, 0);
    root.add(part);
    const box = boxOf(bakeInto(root, material));
    expect(box.min.x).toBeCloseTo(9, 5);
    expect(box.max.x).toBeCloseTo(11, 5);
  });

  it('leaves out what is hidden, and writes out each instance', () => {
    const root = new Group();
    const hidden = new Mesh(new BoxGeometry(1, 1, 1));
    hidden.visible = false;
    const many = new InstancedMesh(new BoxGeometry(1, 1, 1), material, 3);
    for (let index = 0; index < 3; index++) many.setMatrixAt(index, new Matrix4().makeTranslation(index * 10, 0, 0));
    root.add(hidden, many);
    const baked = bakeInto(root, material);
    expect(baked.geometry.getAttribute('position').count).toBe(3 * 36);
    expect(boxOf(baked).max.x).toBeCloseTo(20.5, 5);
  });

  it('keeps the faces of a mirrored part facing out', () => {
    const faceNormal = (mesh: Mesh): Vector3 => {
      const at = mesh.geometry.getAttribute('position');
      const [a, b, c] = [0, 1, 2].map((index) => new Vector3().fromBufferAttribute(at, index));
      return b!.sub(a!).cross(c!.sub(a!)).normalize();
    };
    const plain = new Group();
    plain.add(new Mesh(new BoxGeometry(1, 1, 1)));
    const mirrored = new Group();
    const part = new Mesh(new BoxGeometry(1, 1, 1));
    part.scale.x = -1;
    mirrored.add(part);
    // The first face of a box looks along +x; mirrored in x, its winding must still make it look outward, along -x.
    expect(faceNormal(bakeInto(plain, material)).x).toBeCloseTo(1, 5);
    expect(faceNormal(bakeInto(mirrored, material)).x).toBeCloseTo(-1, 5);
  });

  it('does not fail on a model with nothing showing', () => {
    const root = new Group();
    expect(bakeInto(root, material).geometry.getAttribute('position')).toBeUndefined();
  });
});

describe('the question before a payment', () => {
  const money = (minor: number): string => `$${minor / 100}`;

  it('finds reported work not paid for yet, as the survey reported done with nothing paid', () => {
    const check = payCheckOf({ expected: 900_000, paid: 0 }, 100);
    expect(check).toMatchObject({ earnedMinor: 900_000, owedMinor: 900_000, aheadMinor: 0 });
    expect(payCheckWords(check, money)).toBe('$9000 of reported work not paid yet');
  });

  it('finds money paid ahead of the work reported', () => {
    const check = payCheckOf({ expected: 100_000, paid: 80_000 }, 60);
    expect(check).toMatchObject({ aheadMinor: 20_000, owedMinor: 0 });
    expect(payCheckWords(check, money)).toBe('Paid $200 ahead of the work reported');
  });

  it('passes money that matches the work, and a rounding difference with it', () => {
    expect(payCheckWords(payCheckOf({ expected: 18_750_000, paid: 1_875_000 }, 10), money)).toBe('Paid in line with the work reported');
    expect(payCheckOf({ expected: 100_000, paid: 50_050 }, 50)).toMatchObject({ aheadMinor: 0, owedMinor: 0 });
  });

  it('says so when nothing has happened yet', () => {
    expect(payCheckWords(payCheckOf({ expected: 100_000, paid: 0 }, 0), money)).toBe('Nothing reported, nothing paid');
  });

  it('shows the model as far as it has been reported, whatever the date says', () => {
    const plan = { state: 'done', built: 1, day: 0, of: 6 } as const;
    expect(reportedProgress(40, plan)).toMatchObject({ state: 'active', built: 0.4 });
    expect(reportedProgress(0, plan)).toMatchObject({ state: 'ahead', built: 0 });
    expect(reportedProgress(100, { ...plan, state: 'ahead', built: 0 })).toMatchObject({ state: 'done', built: 1 });
  });
});

describe('what a day on the track says', () => {
  const day = (date: number, kind: DayTile['kind'], costMinor = 0): DayTile => ({ at: new Date(2027, 1, date).getTime(), kind, costMinor });
  const tiles = [day(1, 'idle', 60_000), day(2, 'idle', 60_000), day(3, 'work'), day(4, 'work'), day(5, 'off'), day(6, 'work'), day(7, 'work'), day(8, 'idle', 60_000)];
  const money = (minor: number): string => `$${minor / 100}`;

  it('counts work days only, so a day off does not move a machine\'s working cost', () => {
    expect(workDaysBegun(tiles, day(3, 'work').at)).toBe(0.25);
    expect(workDaysBegun(tiles, day(5, 'off').at)).toBe(0.5);
    expect(workDaysBegun(tiles, day(7, 'work').at)).toBe(1);
    expect(workDaysBegun(tiles, day(2, 'idle').at)).toBe(0);
    expect(workDaysBegun([], 0)).toBe(0);
  });

  it('says what the plan has on each day, as the plan and not as what will happen', () => {
    expect(dayWords(tiles[0]!, tiles, 'Crane', money)).toBe('Mon, Feb 1: Crane booked, no work planned, \u2212$600');
    expect(dayWords(tiles[3]!, tiles, 'Crane', money)).toBe('Thu, Feb 4: planned day 2 of 4');
    expect(dayWords(tiles[4]!, tiles, 'Crane', money)).toBe('Fri, Feb 5: day off');
    expect(dayWords(day(1, 'idle'), tiles, null, money)).toBe('Mon, Feb 1: Machine booked, no work planned');
  });

  it('calls a day after the work what it is: the same as a day before it', () => {
    expect(dayWords(tiles[7]!, tiles, 'Crane', money)).toBe('Mon, Feb 8: Crane booked, no work planned, \u2212$600');
  });

  it('turns the day at local midnight, not at Greenwich', () => {
    const lateEvening = new Date(2027, 1, 9, 23, 30).getTime();
    const nextMorning = new Date(2027, 1, 10, 0, 30).getTime();
    const sameEvening = new Date(2027, 1, 9, 16, 0).getTime();
    expect(dayKey(lateEvening)).not.toBe(dayKey(nextMorning));
    expect(dayKey(lateEvening)).toBe(dayKey(sameEvening));
  });
});

describe('what each person in a room is there to do', () => {
  const work = { x: 0, y: 0, w: 100, d: 60 };
  const stock = [{ x: -150, y: 80 }, { x: 150, y: 80 }];
  const machine = { x: -120, y: -20 };

  it('someone signals for the machine, looking at it', () => {
    const jobs = roomJobs([true, true, true], { work, stock, machine });
    expect(jobs[0]).toHaveLength(1);
    expect(jobs[0]![0]!.pose).toBe('wave');
    expect(jobs[0]![0]!.face).toEqual(machine);
  });

  it('with no machine nobody signals', () => {
    const jobs = roomJobs([true, true, true, true], { work, stock, machine: null });
    expect(jobs.flat().some((stop) => stop.pose === 'wave')).toBe(false);
  });

  it('those who carry go between a pile and the edge of the work, and the work is what they go to', () => {
    const carrier = roomJobs([true, true, true], { work, stock, machine }).find((stops) => stops[0]?.x === stock[0]!.x);
    expect(carrier).toHaveLength(2);
    const drop = carrier![1]!;
    expect(Math.abs(drop.x)).toBeLessThanOrEqual(work.w / 2 + 6);
    expect(Math.abs(drop.y)).toBeLessThanOrEqual(work.d / 2 + 6);
    expect(drop.face).toEqual({ x: 0, y: 0 });
  });

  it('nothing to carry means nobody carries', () => {
    const jobs = roomJobs([true, true, true], { work, stock: [], machine: null });
    expect(jobs).toHaveLength(3);
    for (const stops of jobs) expect(stops[0]!.pose).toBe('hands');
  });

  it('someone who cannot walk stays at one spot at the work, facing it, and never signals', () => {
    const jobs = roomJobs([false, false], { work, stock, machine });
    for (const stops of jobs) {
      expect(stops).toHaveLength(1);
      expect(stops[0]!.pose).toBe('hands');
      expect(stops[0]!.face).toEqual({ x: 0, y: 0 });
      // Around the work, not in it.
      expect(Math.abs(stops[0]!.x) > work.w / 2 || Math.abs(stops[0]!.y) > work.d / 2).toBe(true);
    }
  });

  it('spreads those at the work around it', () => {
    const jobs = roomJobs([false, false, false, false], { work, stock, machine: null });
    const spots = new Set(jobs.map((stops) => `${Math.round(stops[0]!.x)},${Math.round(stops[0]!.y)}`));
    expect(spots.size).toBe(4);
  });
});

describe('a person on a job', () => {
  it('walks to each stop in turn, does what it says, and moves only while walking', () => {
    const poses: string[] = [];
    const amble = createAmble(1, (pose) => poses.push(pose));
    const at = { x: 0, y: 0, heading: 0 };
    amble.setOnSite(true);
    amble.follow([
      { x: 10, y: 0, hold: 1, pose: 'hands' },
      { x: 0, y: 0, hold: 1, pose: 'wave' },
    ]);
    expect(poses.at(-1)).toBe('walk');
    for (let step = 0; step < 400 && poses.at(-1) === 'walk'; step++) amble.step(0.05, at, 10);
    expect(poses.at(-1)).toBe('hands');
    const stopped = { ...at };
    amble.step(0.5, at, 10);
    expect(at.x).toBe(stopped.x);
    // Its hold over, on to the next.
    amble.step(0.6, at, 10);
    expect(poses.at(-1)).toBe('walk');
    for (let step = 0; step < 400 && poses.at(-1) === 'walk'; step++) amble.step(0.05, at, 10);
    expect(poses.at(-1)).toBe('wave');
  });

  it('with one stop stays there, and turns to face what it says', () => {
    const poses: string[] = [];
    const amble = createAmble(2, (pose) => poses.push(pose));
    const at = { x: 5, y: 0, heading: 0 };
    amble.setOnSite(true);
    amble.follow([{ x: 5, y: 0, hold: 0.1, pose: 'wave', face: { x: 5, y: 50 } }]);
    amble.step(0.05, at, 10);
    expect(poses.at(-1)).toBe('wave');
    for (let step = 0; step < 200; step++) amble.step(0.05, at, 10);
    expect(poses.at(-1)).toBe('wave');
    expect(at.heading).toBeCloseTo(Math.PI / 2, 2);
    expect(at.x).toBe(5);
  });

  it('standing somewhere else drops the job', () => {
    const poses: string[] = [];
    const amble = createAmble(3, (pose) => poses.push(pose));
    amble.setOnSite(true);
    amble.follow([{ x: 50, y: 0, hold: 1, pose: 'wave' }]);
    amble.stopAt({ x: 0, y: 0, w: 10, d: 10 });
    const at = { x: 0, y: 0, heading: 0 };
    for (let step = 0; step < 800; step++) amble.step(0.05, at, 10);
    expect(poses).not.toContain('wave');
  });

  it('off site a job waits, and coming on site starts it', () => {
    const poses: string[] = [];
    const amble = createAmble(4, (pose) => poses.push(pose));
    amble.follow([{ x: 50, y: 0, hold: 1, pose: 'hands' }]);
    expect(poses.at(-1)).toBe('stand');
    amble.setOnSite(true);
    expect(poses.at(-1)).toBe('walk');
  });
});

describe('a prop fitted to its place', () => {
  it('scales by the longest side, whichever that is', () => {
    expect(fitOnGround({ x: 1, y: 2, z: 4 }, 20)).toBe(5);
    expect(fitOnGround({ x: 10, y: 2, z: 4 }, 20)).toBe(2);
  });
});
