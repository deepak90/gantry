/**
 * The work front: a pin that travels the road in step with the date, along each plot while its work is on and down
 * the road between them. The route and its timing are worked out here from the plan alone. Work that runs side by
 * side has one pin, which waits at whichever plot finishes last before moving on.
 */
import { Group, Mesh } from 'three';
import type { SignPart } from './standing-models';

const DAY_MS = 86_400_000;
/** Even when the next work starts the moment this one ends, the pin takes a little while on the road. */
const ROAD_TIME = DAY_MS * 0.6;

export interface FrontPoint {
  x: number;
  y: number;
}

export interface FrontStop {
  /** The road on the way in from the stop before, ending at this plot's edge. */
  road: readonly FrontPoint[];
  /** Along the plot's front, from the end the road comes in to the end it leaves by. */
  along: readonly FrontPoint[];
  start: number;
  end: number;
}

interface Leg {
  from: FrontPoint;
  to: FrontPoint;
  fromAt: number;
  toAt: number;
}

export interface FrontRoute {
  legs: Leg[];
  at(time: number): { x: number; y: number; heading: number };
}

const lengthOf = (points: readonly FrontPoint[]): number => points.reduce((sum, point, index) => (index === 0 ? 0 : sum + Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y)), 0);

function addPath(legs: Leg[], points: readonly FrontPoint[], fromAt: number, toAt: number): void {
  const total = lengthOf(points);
  let walked = 0;
  for (let index = 1; index < points.length; index++) {
    const [a, b] = [points[index - 1]!, points[index]!];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span < 0.001) continue;
    const share = (value: number): number => (total > 0 ? value / total : 1);
    legs.push({ from: a, to: b, fromAt: fromAt + (toAt - fromAt) * share(walked), toAt: fromAt + (toAt - fromAt) * share(walked + span) });
    walked += span;
  }
}

/** The whole drive, with every moment of it on one road: it never goes backward in time and never jumps. */
export function frontRoute(stops: readonly FrontStop[]): FrontRoute {
  const legs: Leg[] = [];
  let clock = -Infinity;
  stops.forEach((stop, index) => {
    const arrive = Math.max(stop.start, index === 0 ? stop.start : clock + ROAD_TIME);
    if (stop.road.length > 1) addPath(legs, stop.road, arrive - ROAD_TIME, arrive);
    const next = stops[index + 1];
    // It leaves in time to get to the next work when that begins, unless its own work holds it longer.
    const leave = Math.max(arrive + DAY_MS * 0.25, Math.min(stop.end, next ? Math.max(next.start - ROAD_TIME, arrive + DAY_MS * 0.25) : stop.end));
    addPath(legs, stop.along, arrive, leave);
    clock = leave;
  });
  return {
    legs,
    at(time) {
      const first = legs[0];
      const last = legs[legs.length - 1];
      if (!first || !last) return { x: 0, y: 0, heading: 0 };
      if (time <= first.fromAt) return { x: first.from.x, y: first.from.y, heading: Math.atan2(first.to.y - first.from.y, first.to.x - first.from.x) };
      for (const leg of legs) {
        if (time > leg.toAt) continue;
        if (time < leg.fromAt) return { x: leg.from.x, y: leg.from.y, heading: Math.atan2(leg.to.y - leg.from.y, leg.to.x - leg.from.x) };
        const share = leg.toAt > leg.fromAt ? (time - leg.fromAt) / (leg.toAt - leg.fromAt) : 1;
        return { x: leg.from.x + (leg.to.x - leg.from.x) * share, y: leg.from.y + (leg.to.y - leg.from.y) * share, heading: Math.atan2(leg.to.y - leg.from.y, leg.to.x - leg.from.x) };
      }
      return { x: last.to.x, y: last.to.y, heading: Math.atan2(last.to.y - last.from.y, last.to.x - last.from.x) };
    },
  };
}

export interface FrontMarker {
  root: Group;
  /** Stands it on the road, turned to the camera. */
  place(x: number, y: number, facing: number): void;
  /** How much it stands up from the road, from nothing to all of it. */
  rise(u: number): void;
}

/** A plain pin, from a model that loads on its own, so it is added once it is here. */
export function createFrontMarker(parts: () => readonly SignPart[] | null): FrontMarker {
  const root = new Group();
  const body = new Group();
  root.add(body);
  let built = false;
  return {
    root,
    place(x, y, facing) {
      if (!built) {
        const loaded = parts();
        if (loaded) {
          built = true;
          for (const { geometry, material } of loaded) {
            const mesh = new Mesh(geometry, material);
            mesh.castShadow = true;
            body.add(mesh);
          }
        }
      }
      root.position.set(x, y, 0);
      body.rotation.z = facing;
    },
    rise(u) {
      root.visible = u > 0.01;
      root.scale.setScalar(Math.max(0.01, u));
    },
  };
}
