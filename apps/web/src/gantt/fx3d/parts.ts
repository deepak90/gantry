/**
 * The pieces of the scale models: materials, members and machines, all drawn in code so there is no
 * model file to download. Units are CSS pixels on the sheet and z is up. Everything that moves takes
 * plain numbers, so a model's whole state can be worked out from how far the work has come.
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropKit } from './props';

// -----------------------------------------------------------------------------------------
// Timing helpers
// -----------------------------------------------------------------------------------------

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** How far `value` has come from `from` to `to`, from 0 to 1. */
export const within = (value: number, from: number, to: number): number => clamp01((value - from) / (to - from));
export const smooth = (t: number): number => t * t * (3 - 2 * t);
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Reads a list of `[time, values]` keys at `t` with smoothed steps between them. */
export function keyed(t: number, keys: readonly (readonly [number, readonly number[]])[]): number[] {
  const first = keys[0]!;
  if (t <= first[0]) return [...first[1]];
  for (let index = 1; index < keys.length; index++) {
    const before = keys[index - 1]!;
    const after = keys[index]!;
    if (t <= after[0]) {
      const step = smooth(within(t, before[0], after[0]));
      return before[1].map((value, i) => lerp(value, after[1][i] ?? value, step));
    }
  }
  return [...keys[keys.length - 1]![1]];
}

// -----------------------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------------------

function grainTexture(base: readonly [number, number, number], spread: number, repeat: number): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const grain = (Math.random() - 0.5) * spread;
    image.data[i] = base[0] + grain;
    image.data[i + 1] = base[1] + grain;
    image.data[i + 2] = base[2] + grain;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  return texture;
}

export function createMaterials() {
  const shared = <T extends Material>(material: T): T => {
    material.userData.shared = true;
    return material;
  };
  return {
    steel: shared(new MeshStandardMaterial({ color: '#5d7894', metalness: 0.72, roughness: 0.38 })),
    bolt: shared(new MeshStandardMaterial({ color: '#cfd6dc', metalness: 0.9, roughness: 0.25 })),
    concrete: shared(new MeshStandardMaterial({ map: grainTexture([186, 188, 188], 22, 0.03), roughness: 0.94 })),
    soil: shared(new MeshStandardMaterial({ map: grainTexture([122, 92, 58], 30, 0.04), roughness: 1 })),
    /** Soil tinted cell by cell: the grain only, so the tints come through true. */
    soilGrain: shared(new MeshStandardMaterial({ map: grainTexture([236, 236, 236], 24, 1), roughness: 1 })),
    window: shared(new MeshStandardMaterial({ color: '#1d2a33', metalness: 0.85, roughness: 0.12 })),
    gravel: shared(new MeshStandardMaterial({ map: grainTexture([150, 146, 138], 46, 0.06), roughness: 1 })),
    rebar: shared(new MeshStandardMaterial({ color: '#7b6a5a', metalness: 0.6, roughness: 0.55 })),
    hiVis: shared(new MeshStandardMaterial({ color: '#e7ad1c', metalness: 0.15, roughness: 0.42 })),
    machineDark: shared(new MeshStandardMaterial({ color: '#2c3238', metalness: 0.4, roughness: 0.6 })),
    rubber: shared(new MeshStandardMaterial({ color: '#1f2226', roughness: 0.92 })),
    white: shared(new MeshStandardMaterial({ color: '#eef0f1', roughness: 0.5 })),
    cabin: shared(new MeshStandardMaterial({ color: '#dfe3e4', roughness: 0.62 })),
    panel: shared(new MeshStandardMaterial({ color: '#c9ced0', metalness: 0.25, roughness: 0.55 })),
    deck: shared(new MeshStandardMaterial({ color: '#8d969c', metalness: 0.55, roughness: 0.46 })),
    glass: shared(new MeshPhysicalMaterial({ color: '#a9c8d8', metalness: 0, roughness: 0.06, transparent: true, opacity: 0.45, clearcoat: 1 })),
    stud: shared(new MeshStandardMaterial({ color: '#aeb4b8', metalness: 0.7, roughness: 0.4 })),
    copper: shared(new MeshStandardMaterial({ color: '#b5714a', metalness: 0.85, roughness: 0.3 })),
    duct: shared(new MeshStandardMaterial({ color: '#b9c1c7', metalness: 0.8, roughness: 0.34 })),
    pipe: shared(new MeshStandardMaterial({ color: '#3f6f9a', metalness: 0.3, roughness: 0.42 })),
    drywall: shared(new MeshStandardMaterial({ color: '#d7d6cf', roughness: 0.9 })),
    timber: shared(new MeshStandardMaterial({ map: grainTexture([178, 142, 98], 26, 0.05), roughness: 0.74 })),
    skin: shared(new MeshStandardMaterial({ color: '#c79b7b', roughness: 0.7 })),
    vest: shared(new MeshStandardMaterial({ color: '#d9a51e', roughness: 0.7 })),
    trousers: shared(new MeshStandardMaterial({ color: '#39424c', roughness: 0.85 })),
    ok: shared(new MeshStandardMaterial({ color: '#2d8a58', roughness: 0.5 })),
  };
}

export type Materials = ReturnType<typeof createMaterials>;

// -----------------------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------------------

export function solid(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export const box = (w: number, d: number, h: number): BufferGeometry => new BoxGeometry(w, d, h);
export const roundBox = (w: number, d: number, h: number, radius = 2): BufferGeometry => new RoundedBoxGeometry(w, d, h, 3, Math.min(radius, Math.min(w, d, h) / 2 - 0.01));

const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/** A round bar between two points, for merging into a lattice. */
export function strut(a: Vector3, b: Vector3, radius: number, sides = 5): BufferGeometry {
  const length = a.distanceTo(b);
  const geometry = new CylinderGeometry(radius, radius, length, sides, 1, false);
  const direction = new Vector3().subVectors(b, a).normalize();
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(Y_AXIS, direction));
  const middle = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  geometry.translate(middle.x, middle.y, middle.z);
  return geometry;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** A cylinder standing on its base, along z. */
export function upright(radius: number, height: number, sides = 12, top = radius): BufferGeometry {
  const geometry = new CylinderGeometry(top, radius, height, sides);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, height / 2);
  return geometry;
}

/** A wide-flange section of unit length along +z, to be stretched to each member's length. */
export function iSection(size: number): BufferGeometry {
  const w = size / 2;
  const d = size * 0.62;
  const flange = size * 0.2;
  const web = size * 0.16;
  const shape = new Shape();
  shape.moveTo(-w, -d);
  shape.lineTo(w, -d);
  shape.lineTo(w, -d + flange);
  shape.lineTo(web, -d + flange);
  shape.lineTo(web, d - flange);
  shape.lineTo(w, d - flange);
  shape.lineTo(w, d);
  shape.lineTo(-w, d);
  shape.lineTo(-w, d - flange);
  shape.lineTo(-web, d - flange);
  shape.lineTo(-web, -d + flange);
  shape.lineTo(-w, -d + flange);
  shape.closePath();
  return new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 });
}

/** A steel member stretched from `a` to `b`. Its origin is `a`. */
export function member(section: BufferGeometry, material: Material, a: Vector3, b: Vector3): Mesh {
  const mesh = solid(section, material, a.x, a.y, a.z);
  mesh.quaternion.setFromUnitVectors(Z_AXIS, new Vector3().subVectors(b, a).normalize());
  mesh.scale.z = a.distanceTo(b);
  return mesh;
}

/** An outline in the xz plane given some thickness along y, for the arms of machines. */
function armPlate(points: readonly (readonly [number, number])[], thickness: number): BufferGeometry {
  const shape = new Shape();
  points.forEach(([x, z], index) => (index === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z)));
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  return geometry;
}

const wheel = (radius: number, width: number) => {
  const geometry = new CylinderGeometry(radius, radius, width, 18);
  return geometry;
};

// -----------------------------------------------------------------------------------------
// Tower crane
// -----------------------------------------------------------------------------------------

export interface Crane {
  root: Group;
  height: number;
  /** Turn the jib, move the trolley along it, and let the hook down to a height above the site. */
  pose(azimuth: number, radius: number, hookZ: number): void;
  /** The amber beacon: on while the machine is on site and doing nothing. */
  beacon(on: boolean, time: number): void;
}

export function towerCrane(m: Materials, height = 300, jib = 350): Crane {
  const root = new Group();
  root.userData.machine = true;
  root.add(solid(roundBox(70, 70, 12, 2), m.concrete, 0, 0, 6));
  root.add(solid(roundBox(34, 34, 8, 1), m.machineDark, 0, 0, 16));

  const half = 9;
  const legs = [v(-half, -half, 0), v(half, -half, 0), v(half, half, 0), v(-half, half, 0)];
  const parts: BufferGeometry[] = [];
  const sections = 14;
  const rise = (height - 20) / sections;
  legs.forEach((leg, side) => {
    const next = legs[(side + 1) % 4]!;
    parts.push(strut(v(leg.x, leg.y, 20), v(leg.x, leg.y, height), 1.5));
    for (let level = 0; level < sections; level++) {
      const z = 20 + level * rise;
      parts.push(strut(v(leg.x, leg.y, z), v(next.x, next.y, z), 0.7));
      const flip = level % 2 === 0;
      parts.push(strut(v(flip ? leg.x : next.x, flip ? leg.y : next.y, z), v(flip ? next.x : leg.x, flip ? next.y : leg.y, z + rise), 0.7));
    }
  });
  root.add(solid(mergeGeometries(parts), m.hiVis));

  const slew = new Group();
  slew.position.z = height;
  root.add(slew);
  slew.add(solid(upright(15, 7, 20), m.machineDark));

  const jibParts: BufferGeometry[] = [];
  const chordY = 7;
  const chordZ = 14;
  const base = 10;
  jibParts.push(strut(v(0, -chordY, base), v(jib, -chordY * 0.4, base), 1.3));
  jibParts.push(strut(v(0, chordY, base), v(jib, chordY * 0.4, base), 1.3));
  jibParts.push(strut(v(0, 0, base + chordZ), v(jib, 0, base + 3), 1.3));
  const bays = 18;
  for (let bay = 0; bay < bays; bay++) {
    const x0 = (bay / bays) * jib;
    const x1 = ((bay + 1) / bays) * jib;
    const taper = (x: number) => 1 - (x / jib) * 0.6;
    const top = (x: number) => base + chordZ + (x / jib) * (3 - chordZ);
    jibParts.push(strut(v(x0, -chordY * taper(x0), base), v(x1, 0, top(x1)), 0.6));
    jibParts.push(strut(v(x0, chordY * taper(x0), base), v(x1, 0, top(x1)), 0.6));
    jibParts.push(strut(v(x1, -chordY * taper(x1), base), v(x1, chordY * taper(x1), base), 0.6));
  }
  slew.add(solid(mergeGeometries(jibParts), m.hiVis));

  // Counter-jib, its weights, the cat-head and the ties that hold it all up.
  const counter = 104;
  const counterParts: BufferGeometry[] = [
    strut(v(0, -7, base), v(-counter, -7, base), 1.3),
    strut(v(0, 7, base), v(-counter, 7, base), 1.3),
  ];
  for (let bay = 0; bay < 6; bay++) {
    const x = -(bay / 6) * counter;
    const next = -((bay + 1) / 6) * counter;
    counterParts.push(strut(v(x, -7, base), v(next, 7, base), 0.6));
    counterParts.push(strut(v(next, -7, base), v(next, 7, base), 0.6));
  }
  slew.add(solid(mergeGeometries(counterParts), m.hiVis));
  for (let i = 0; i < 4; i++) slew.add(solid(roundBox(11, 24, 30, 1), m.concrete, -counter + 8 + i * 12.5, 0, base - 12));

  const catHead = 76;
  slew.add(
    solid(
      mergeGeometries([
        strut(v(-7, -7, base), v(0, 0, base + catHead), 1.5),
        strut(v(-7, 7, base), v(0, 0, base + catHead), 1.5),
        strut(v(7, -7, base), v(0, 0, base + catHead), 1.5),
        strut(v(7, 7, base), v(0, 0, base + catHead), 1.5),
      ]),
      m.hiVis,
    ),
  );
  slew.add(
    solid(
      mergeGeometries([
        strut(v(0, 0, base + catHead), v(jib * 0.72, 0, base + 6), 0.5, 4),
        strut(v(0, 0, base + catHead), v(jib * 0.36, 0, base + 10), 0.5, 4),
        strut(v(0, 0, base + catHead), v(-counter * 0.9, 0, base), 0.5, 4),
      ]),
      m.machineDark,
    ),
  );

  // Operator's cab, tucked beside the root of the jib.
  const cab = new Group();
  cab.position.set(10, -17, base - 4);
  cab.add(solid(roundBox(20, 15, 17, 2), m.white, 0, 0, 0));
  cab.add(solid(roundBox(6, 13, 11, 1), m.window, 8.5, 0, 1.5));
  slew.add(cab);

  const beaconLight = new MeshStandardMaterial({ color: '#7a5a10', emissive: '#ffae12', emissiveIntensity: 0, roughness: 0.3 });
  const beaconMesh = solid(new SphereGeometry(3.2, 12, 10), beaconLight, 0, 0, base + catHead + 3);
  beaconMesh.castShadow = false;
  slew.add(beaconMesh);

  const trolley = new Group();
  trolley.position.z = base - 2;
  slew.add(trolley);
  trolley.add(solid(roundBox(16, 11, 5, 1), m.machineDark));

  const cableGeometry = new CylinderGeometry(0.55, 0.55, 1, 5);
  cableGeometry.rotateX(Math.PI / 2);
  cableGeometry.translate(0, 0, -0.5);
  const cable = solid(cableGeometry, m.machineDark);
  trolley.add(cable);

  const hook = new Group();
  hook.add(solid(roundBox(9, 6, 8, 1), m.hiVis, 0, 0, 2));
  hook.add(solid(upright(1.4, 6, 8), m.machineDark, 0, 0, -6));
  trolley.add(hook);

  const trolleyZ = height + trolley.position.z;

  return {
    root,
    height,
    pose(azimuth, radius, hookZ) {
      slew.rotation.z = azimuth;
      trolley.position.x = radius;
      const drop = Math.max(2, trolleyZ - hookZ);
      cable.scale.z = drop;
      hook.position.z = -drop;
    },
    beacon(on, time) {
      beaconLight.emissiveIntensity = on ? 1.2 + 2.2 * Math.max(0, Math.sin(time * 5)) : 0;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Concrete pump truck
// -----------------------------------------------------------------------------------------

export interface Pump {
  root: Group;
  /** Lower the hose's end to a point, given relative to the truck's turret. */
  reach(x: number, y: number, z: number): void;
}

export function pumpTruck(m: Materials): Pump {
  const root = new Group();
  root.userData.machine = true;
  const truck = new Group();
  truck.rotation.z = Math.PI / 2;
  root.add(truck);
  truck.add(solid(roundBox(150, 34, 8, 1), m.machineDark, 0, 0, 15));
  truck.add(solid(roundBox(30, 32, 25, 4), m.white, 66, 0, 31));
  truck.add(solid(roundBox(4, 28, 11, 1), m.window, 80.5, 0, 36));
  truck.add(solid(roundBox(16, 33, 9, 1), m.window, 68, 0, 36));
  truck.add(solid(roundBox(16, 30, 7, 2), m.white, 86, 0, 22));
  truck.add(solid(roundBox(88, 26, 9, 2), m.hiVis, -18, 0, 23.5));
  truck.add(solid(roundBox(20, 28, 16, 2), m.machineDark, -66, 0, 27));
  truck.add(solid(upright(3, 14, 10), m.machineDark, 44, 12, 28));
  [-58, -36, 28, 60].forEach((x) => {
    [-17, 17].forEach((y) => {
      const tire = solid(wheel(9, 8), m.rubber, x, y, 9);
      truck.add(tire);
    });
  });
  // Outriggers on the ground.
  [-34, 34].forEach((x) => {
    [-1, 1].forEach((side) => {
      truck.add(solid(box(8, 24, 4), m.hiVis, x, side * 28, 16));
      truck.add(solid(upright(3, 14, 8), m.machineDark, x, side * 40, 2));
      truck.add(solid(roundBox(16, 16, 2, 0.5), m.timber, x, side * 40, 1));
    });
  });

  const turret = new Group();
  turret.position.set(0, -6, 40);
  root.add(turret);
  turret.add(solid(upright(11, 11, 16), m.machineDark));

  const boomA = 164;
  const boomB = 150;
  const boomC = 96;
  const section = (length: number, size: number) => solid(roundBox(length, size, size, 1), m.hiVis, length / 2, 0, 0);
  const shoulder = new Group();
  shoulder.position.z = 11;
  turret.add(shoulder);
  shoulder.add(section(boomA, 10));
  const elbow = new Group();
  elbow.position.x = boomA;
  shoulder.add(elbow);
  elbow.add(section(boomB, 8));
  const wrist = new Group();
  wrist.position.x = boomB;
  elbow.add(wrist);
  wrist.add(section(boomC, 6));
  const pipeRun = solid(box(boomC, 2, 2), m.machineDark, boomC / 2, 0, 4);
  wrist.add(pipeRun);

  const hoseGeometry = new CylinderGeometry(2.1, 2.1, 1, 8);
  hoseGeometry.rotateX(Math.PI / 2);
  hoseGeometry.translate(0, 0, -0.5);
  const hose = solid(hoseGeometry, m.rubber);
  turret.add(hose);

  return {
    root,
    reach(x, y, z) {
      const relX = x - turret.position.x;
      const relY = y - turret.position.y;
      const yaw = Math.atan2(relY, relX);
      turret.rotation.z = yaw;
      const out = Math.hypot(relX, relY);
      const hoseLength = 30;
      // The last section points down and out at a fixed slope; two sections reach its root.
      const wristOut = out - boomC * Math.cos(0.42);
      const wristUp = z + hoseLength + boomC * Math.sin(0.42) - turret.position.z - shoulder.position.z;
      const span = Math.min(boomA + boomB - 1, Math.hypot(wristOut, wristUp));
      const toWrist = Math.atan2(wristUp, wristOut);
      const inner = Math.acos(Math.min(1, Math.max(-1, (boomA * boomA + span * span - boomB * boomB) / (2 * boomA * span))));
      const shoulderAngle = toWrist + inner;
      const elbowOut = boomA * Math.cos(shoulderAngle);
      const elbowUp = boomA * Math.sin(shoulderAngle);
      const forearm = Math.atan2(wristUp - elbowUp, wristOut - elbowOut);
      shoulder.rotation.y = -shoulderAngle;
      elbow.rotation.y = -(forearm - shoulderAngle);
      wrist.rotation.y = -(-0.42 - forearm);
      hose.position.set(out, 0, z + hoseLength - turret.position.z);
      hose.scale.z = hoseLength;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Excavator
// -----------------------------------------------------------------------------------------

export interface Excavator {
  root: Group;
  pose(yaw: number, boom: number, stick: number, bucket: number): void;
}

/** How much bigger than life the real excavator is drawn, to read beside the rest of the model. */
const REAL_EXCAVATOR_SCALE = 30;
/** Where its parts stand in the file, in the angles `pose` is given. */
const REAL_EXCAVATOR_REST = { boom: 0.35, stick: 1.63, bucket: 0.2 };

/**
 * The excavator as a real model (credited in public/models/CREDITS.md), posed like the one drawn in code; null if it did
 * not load. Its boom, arm and bucket come side by side under the upper part, so here each is hung on the one before it.
 */
export function realExcavator(props: PropKit | null): Excavator | null {
  const model = props?.raw('excavator');
  const [upper, boom, arm, bucket] = ['upper', 'boom', 'arm', 'bucket'].map((part) => model?.getObjectByName(`excavator_${part}`));
  if (!model || !upper || !boom || !arm || !bucket) return null;
  const root = new Group();
  root.userData.machine = true;
  // The file is up along y and faces +z; the site is up along z, and a machine faces +x.
  const turned = new Group();
  turned.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)));
  turned.scale.setScalar(REAL_EXCAVATOR_SCALE);
  // It turns about the middle of its tracks, so that is what stands on the spot.
  model.position.z = -upper.position.z;
  turned.add(model);
  root.add(turned);
  root.updateWorldMatrix(true, true);
  boom.attach(arm);
  arm.attach(bucket);
  return {
    root,
    pose(yaw, boomAngle, stickAngle, bucketAngle) {
      upper.rotation.y = yaw;
      boom.rotation.x = REAL_EXCAVATOR_REST.boom - boomAngle;
      arm.rotation.x = -stickAngle - REAL_EXCAVATOR_REST.stick;
      bucket.rotation.x = -bucketAngle - REAL_EXCAVATOR_REST.bucket;
    },
  };
}

export function excavator(m: Materials): Excavator {
  const root = new Group();
  root.userData.machine = true;
  [-27, 27].forEach((y) => {
    root.add(solid(roundBox(104, 17, 18, 8), m.rubber, 0, y, 9));
    root.add(solid(roundBox(78, 18.4, 8, 3), m.machineDark, 0, y, 9));
  });
  root.add(solid(roundBox(58, 38, 8, 1), m.machineDark, 0, 0, 18));
  const house = new Group();
  house.position.z = 22;
  root.add(house);
  house.add(solid(upright(19, 4, 22), m.machineDark));
  house.add(solid(roundBox(82, 52, 16, 3), m.hiVis, -10, 0, 12));
  house.add(solid(roundBox(20, 50, 22, 3), m.machineDark, -44, 0, 13));
  house.add(solid(roundBox(28, 24, 30, 3), m.hiVis, 12, 13, 33));
  house.add(solid(roundBox(20, 25, 16, 2), m.window, 16, 13, 36));
  house.add(solid(roundBox(34, 18, 10, 2), m.machineDark, -22, -14, 24));

  const boom = new Group();
  boom.position.set(22, -8, 14);
  house.add(boom);
  const boomLength = 92;
  boom.add(solid(armPlate([[-5, -6], [boomLength * 0.42, 9], [boomLength + 3, -3], [boomLength + 3, -9], [boomLength * 0.42, 0], [-5, 2]].map(([x, z]) => [x!, z!] as const), 11), m.hiVis));
  const stick = new Group();
  stick.position.x = boomLength;
  stick.position.z = -6;
  boom.add(stick);
  const stickLength = 66;
  stick.add(solid(armPlate([[-3, 6], [stickLength, 2], [stickLength, -3], [-3, -5]], 8), m.machineDark));
  const bucket = new Group();
  bucket.position.x = stickLength;
  stick.add(bucket);
  bucket.add(solid(armPlate([[0, 4], [12, 7], [24, -3], [30, -20], [12, -12], [0, -4]], 18), m.machineDark));

  return {
    root,
    pose(yaw, boomAngle, stickAngle, bucketAngle) {
      house.rotation.z = yaw;
      boom.rotation.y = -boomAngle;
      stick.rotation.y = -stickAngle;
      bucket.rotation.y = -bucketAngle;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Scissor lift
// -----------------------------------------------------------------------------------------

export interface Lift {
  root: Group;
  rise(height: number): void;
}

export function scissorLift(m: Materials): Lift {
  const root = new Group();
  root.userData.machine = true;
  root.add(solid(roundBox(52, 26, 10, 2), m.machineDark, 0, 0, 10));
  [-18, 18].forEach((x) => {
    [-14, 14].forEach((y) => {
      root.add(solid(wheel(5.5, 4.5), m.rubber, x, y, 5.5));
    });
  });
  const stages = 3;
  const barLength = 44;
  const barGeometry = new BoxGeometry(barLength, 2.4, 2.6);
  const bars: Mesh[] = [];
  for (let stage = 0; stage < stages; stage++) {
    [-11, 11].forEach((y) => {
      [1, -1].forEach(() => {
        const bar = solid(barGeometry, m.hiVis, 0, y, 0);
        bars.push(bar);
        root.add(bar);
      });
    });
  }
  const platform = new Group();
  root.add(platform);
  platform.add(solid(roundBox(58, 28, 4, 1), m.hiVis));
  const rail: BufferGeometry[] = [];
  const corners = [v(-27, -12, 2), v(27, -12, 2), v(27, 12, 2), v(-27, 12, 2)];
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % 4]!;
    rail.push(strut(corner, v(corner.x, corner.y, 18), 0.7));
    rail.push(strut(v(corner.x, corner.y, 18), v(next.x, next.y, 18), 0.7));
    rail.push(strut(v(corner.x, corner.y, 10), v(next.x, next.y, 10), 0.5));
  });
  platform.add(solid(mergeGeometries(rail), m.machineDark));

  return {
    root,
    rise(height) {
      const each = Math.min(barLength - 1, Math.max(5, height / stages));
      const angle = Math.asin(each / barLength);
      let index = 0;
      for (let stage = 0; stage < stages; stage++) {
        for (let side = 0; side < 2; side++) {
          for (const direction of [1, -1]) {
            const bar = bars[index++]!;
            bar.position.z = 15 + each * (stage + 0.5);
            bar.rotation.y = direction * angle;
          }
        }
      }
      platform.position.z = 15 + each * stages + 2;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Little people, as on an architect's model
// -----------------------------------------------------------------------------------------

export function figure(m: Materials, hatColor: string, turn = 0): Group {
  const person = new Group();
  person.add(solid(new CapsuleGeometry(2.1, 6, 3, 8).rotateX(Math.PI / 2), m.trousers, 0, 0, 5.5));
  person.add(solid(new CapsuleGeometry(2.8, 5, 3, 8).rotateX(Math.PI / 2), m.vest, 0, 0, 12));
  person.add(solid(new SphereGeometry(2.1, 10, 8), m.skin, 0, 0, 19));
  const hat = new MeshStandardMaterial({ color: hatColor, roughness: 0.4 });
  person.add(solid(new SphereGeometry(2.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), hat, 0, 0, 19.6));
  person.rotation.z = turn;
  person.userData.person = true;
  person.userData.hat = hatColor;
  return person;
}
