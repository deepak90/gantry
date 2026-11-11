/**
 * The camera. World units are CSS pixels and the page lies on the plane z = 0, so at rest the camera sees
 * that plane exactly as the browser laid it out: a mesh put on a bar's rectangle covers that bar, which is
 * how a bar can leave the chart from exactly where it was drawn.
 */
import { PerspectiveCamera, Vector3 } from 'three';

export const FOV = 30;

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Turn around the sheet's normal, in radians. */
  azimuth: number;
  /** Lean away from looking straight down, in radians. */
  elevation: number;
  distance: number;
}

/** The distance at which one world unit on the sheet is one CSS pixel. */
export const restDistance = (height: number, fov = FOV): number => height / 2 / Math.tan((fov * Math.PI) / 360);

export const restPose = (height: number): Pose => ({ x: 0, y: 0, z: 0, azimuth: 0, elevation: 0, distance: restDistance(height) });

export function mixPose(a: Pose, b: Pose, t: number): Pose {
  const mix = (from: number, to: number) => from + (to - from) * t;
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    z: mix(a.z, b.z),
    azimuth: mix(a.azimuth, b.azimuth),
    elevation: mix(a.elevation, b.elevation),
    distance: mix(a.distance, b.distance),
  };
}

const right = new Vector3();
const up = new Vector3();
const back = new Vector3();
const position = new Vector3();

/** Places the camera directly from its basis: `lookAt` has no answer when looking straight down. */
export function placeCamera(camera: PerspectiveCamera, pose: Pose): void {
  const lean = Math.sin(pose.elevation);
  back.set(lean * Math.sin(pose.azimuth), -lean * Math.cos(pose.azimuth), Math.cos(pose.elevation));
  right.set(Math.cos(pose.azimuth), Math.sin(pose.azimuth), 0);
  up.crossVectors(back, right);
  position.set(pose.x, pose.y, pose.z).addScaledVector(back, pose.distance);
  camera.matrixAutoUpdate = false;
  camera.matrix.makeBasis(right, up, back).setPosition(position);
  camera.matrixWorld.copy(camera.matrix);
  camera.matrixWorldInverse.copy(camera.matrix).invert();
  camera.position.copy(position);
}

/** The pose that puts a camera where it is now, looking at this point: `placeCamera` undone. */
export function poseOfCamera(at: Vector3, target: Vector3): Pose {
  const offset = at.clone().sub(target);
  const distance = offset.length() || 1;
  return {
    x: target.x,
    y: target.y,
    z: target.z,
    azimuth: Math.atan2(offset.x, -offset.y),
    elevation: Math.acos(Math.min(1, Math.max(-1, offset.z / distance))),
    distance,
  };
}

/** A point on the page (CSS pixels from the top left) in world units. */
export const pageToWorld = (x: number, y: number, width: number, height: number): { x: number; y: number } => ({
  x: x - width / 2,
  y: height / 2 - y,
});

/** Where something shows in the frame: -1 to 1 across (left to right) and up (bottom to top). */
export interface Spot {
  x: number;
  y: number;
}

/** The camera's lens: its height of view in degrees, and its width for one of height. */
export interface Lens {
  fov: number;
  aspect: number;
}

const probe = new PerspectiveCamera();
const seen = new Vector3();
const across = new Vector3();
const upward = new Vector3();

function shapeProbe(lens: Lens): number {
  probe.fov = lens.fov;
  probe.aspect = lens.aspect;
  probe.near = 1;
  probe.far = 1e6;
  probe.updateProjectionMatrix();
  return Math.tan((lens.fov * Math.PI) / 360);
}

/**
 * The camera standing at `eye`, turned (never tilted sideways) so that `at` shows at `spot` in the frame: the way to
 * keep what a shot is about in the part of the window nothing covers.
 */
export function aimFrom(eye: Vector3, at: Vector3, spot: Spot, lens: Lens): Pose {
  const halfTan = shapeProbe(lens);
  const reach = eye.distanceTo(at);
  const target = at.clone();
  let pose = poseOfCamera(eye, target);
  for (let pass = 0; pass < 8; pass++) {
    placeCamera(probe, pose);
    seen.copy(at).project(probe);
    if (Math.abs(seen.x - spot.x) < 1e-5 && Math.abs(seen.y - spot.y) < 1e-5) break;
    // Turned toward where it shows, by as much as it is off the spot.
    across.setFromMatrixColumn(probe.matrixWorld, 0);
    upward.setFromMatrixColumn(probe.matrixWorld, 1);
    target.addScaledVector(across, (seen.x - spot.x) * reach * halfTan * lens.aspect);
    target.addScaledVector(upward, (seen.y - spot.y) * reach * halfTan);
    pose = poseOfCamera(eye, target);
  }
  return pose;
}

/** Looking at `center` from this side, this high and this far, with `center` showing at `spot` in the frame. */
export function aroundPose(center: Vector3, azimuth: number, elevation: number, distance: number, spot: Spot, lens: Lens): Pose {
  const halfTan = Math.tan((lens.fov * Math.PI) / 360);
  const lean = Math.sin(elevation);
  right.set(Math.cos(azimuth), Math.sin(azimuth), 0);
  back.set(lean * Math.sin(azimuth), -lean * Math.cos(azimuth), Math.cos(elevation));
  up.crossVectors(back, right);
  // The camera looks at its target: the target sits off `center` by just what moves `center` to the spot.
  const sideways = -spot.x * halfTan * lens.aspect * distance;
  const upwards = -spot.y * halfTan * distance;
  return {
    x: center.x + right.x * sideways + up.x * upwards,
    y: center.y + right.y * sideways + up.y * upwards,
    z: center.z + up.z * upwards,
    azimuth,
    elevation,
    distance,
  };
}

/** The camera and what it looks at turned together about the upright through `center`, as a crane's jib turns. */
export function turnPose(pose: Pose, center: { x: number; y: number }, angle: number): Pose {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const [dx, dy] = [pose.x - center.x, pose.y - center.y];
  return { ...pose, x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos, azimuth: pose.azimuth + angle };
}

/**
 * A ride on a tower crane: the camera out past the tip of the jib, off to its side and over it, looking back along it
 * and down at a point a third of the way out from the mast: the hook hangs in front, the lot is below, and the mast
 * stands up at the far end. `base` is the foot of the mast, `heading` the way the jib points.
 */
export function onTheJib(base: Vector3, heading: number, jib: { height: number; reach: number }): { eye: Vector3; look: Vector3 } {
  const [outX, outY] = [Math.cos(heading), Math.sin(heading)];
  // Along the jib from the mast, to its right as it points (a minus is its left), and up from the mast's foot.
  const at = (along: number, aside: number, height: number) => new Vector3(base.x + outX * along + outY * aside, base.y + outY * along - outX * aside, base.z + height);
  return { eye: at(jib.reach + 20, 70, jib.height + 90), look: at(jib.reach * 0.3, 0, 50) };
}
