/**
 * The machines on the building site, drawn in code so that their parts can move: a tower crane that slews, trolleys and
 * lowers its hook, a concrete pump whose boom unfolds to wherever the pour is, a mixer truck with a turning drum, and a
 * scissor lift. Proportions are a real machine's at the building's scale (a worker is about 22 tall, so a meter is
 * about 12.6), and z is up. Static parts are merged per material, so a machine is a handful of draws.
 */
import { BoxGeometry, type BufferGeometry, CanvasTexture, CylinderGeometry, Group, type Material, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// -----------------------------------------------------------------------------------------
// Materials and shapes
// -----------------------------------------------------------------------------------------

export function machineMaterials() {
  const make = (color: string, roughness: number, metalness = 0.1) => new MeshStandardMaterial({ color, roughness, metalness });
  return {
    yellow: make('#f0b31a', 0.46, 0.18),
    orange: make('#e2782f', 0.48, 0.15),
    white: make('#f1f1ee', 0.42, 0.05),
    paint: make('#dfe2e3', 0.5, 0.1),
    dark: make('#2c3136', 0.55, 0.4),
    steel: make('#8c949b', 0.38, 0.75),
    rubber: make('#1d2024', 0.9, 0),
    glass: new MeshStandardMaterial({ color: '#30424f', roughness: 0.08, metalness: 0.6 }),
    ballast: make('#b9b6ae', 0.92, 0),
    drum: make('#d9d6cf', 0.38, 0.35),
    stripe: make('#c9472d', 0.5, 0.05),
    beacon: new MeshStandardMaterial({ color: '#8a5d0c', emissive: '#ffae12', emissiveIntensity: 0, roughness: 0.3 }),
  };
}

export type MachineMaterials = ReturnType<typeof machineMaterials>;

/** Merges shapes made indexed or not (rounded boxes are not): all are made plain first, so they always fit together. */
export function mergeShapes(parts: readonly BufferGeometry[]): BufferGeometry {
  const plain = parts.some((part) => !part.index);
  const ready = plain ? parts.map((part) => (part.index ? part.toNonIndexed() : part)) : [...parts];
  const merged = mergeGeometries(ready);
  if (plain) ready.forEach((part, index) => part !== parts[index] && part.dispose());
  return merged;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const Y = new Vector3(0, 1, 0);

/** A round bar between two points. */
function bar(a: Vector3, b: Vector3, radius: number, sides = 6): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, a.distanceTo(b), sides, 1, false);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(Y, new Vector3().subVectors(b, a).normalize()));
  const middle = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  geometry.translate(middle.x, middle.y, middle.z);
  return geometry;
}

function block(w: number, d: number, h: number, x: number, y: number, z: number, radius = 0): BufferGeometry {
  const geometry = radius > 0 ? new RoundedBoxGeometry(w, d, h, 2, Math.min(radius, Math.min(w, d, h) / 2 - 0.01)) : new BoxGeometry(w, d, h);
  geometry.translate(x, y, z);
  return geometry;
}

function wheelAt(radius: number, width: number, x: number, y: number, z: number): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, width, 20);
  geometry.translate(x, y, z);
  return geometry;
}

function mesh(parts: BufferGeometry[], material: Material, shadows = true): Mesh {
  const merged = new Mesh(mergeShapes(parts), material);
  merged.castShadow = shadows;
  merged.receiveShadow = true;
  for (const part of parts) part.dispose();
  return merged;
}

/** A square lattice section between two heights: four chords, a ring at each panel, a diagonal on each face. */
function latticeMast(half: number, from: number, to: number, panels: number, chord: number, lace: number): BufferGeometry[] {
  const corners = [v(-half, -half, 0), v(half, -half, 0), v(half, half, 0), v(-half, half, 0)];
  const parts: BufferGeometry[] = [];
  const rise = (to - from) / panels;
  corners.forEach((corner, side) => {
    const next = corners[(side + 1) % 4]!;
    parts.push(bar(v(corner.x, corner.y, from), v(corner.x, corner.y, to), chord, 6));
    for (let panel = 0; panel < panels; panel++) {
      const z = from + panel * rise;
      parts.push(bar(v(corner.x, corner.y, z), v(next.x, next.y, z), lace, 4));
      const up = panel % 2 === 0;
      parts.push(bar(v(up ? corner.x : next.x, up ? corner.y : next.y, z), v(up ? next.x : corner.x, up ? next.y : corner.y, z + rise), lace, 4));
    }
  });
  return parts;
}

// -----------------------------------------------------------------------------------------
// Tower crane
// -----------------------------------------------------------------------------------------

export interface TowerCrane {
  root: Group;
  height: number;
  jib: number;
  /** Slews to a heading, runs the trolley out, lowers the hook to a height (all in the crane's own frame). */
  pose(heading: number, reach: number, hookZ: number): void;
  /** Where the hook is, in the crane's own frame. */
  hookAt(target: Vector3): Vector3;
  /** Something hanging from the hook, or nothing. */
  carry(load: Group | null): void;
  beacon(on: boolean, time: number): void;
}

export function towerCrane(m: MachineMaterials, height = 330, jib = 400): TowerCrane {
  const root = new Group();
  root.userData.machine = 'crane';
  const half = 10;

  // The foundation, its ballast, the mast and the climbing frame.
  root.add(mesh([block(64, 64, 10, 0, 0, 5, 1.5)], m.ballast));
  root.add(mesh([block(26, 26, 4, 0, 0, 12, 0.6), ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => block(6, 6, 6, sx * 11, sy * 11, 13, 0.5)))], m.dark));
  const mastTop = height - 6;
  root.add(mesh(latticeMast(half, 14, mastTop, Math.round((mastTop - 14) / 20), 1.35, 0.55), m.yellow));

  const slew = new Group();
  slew.position.z = height;
  root.add(slew);
  // Turntable and the platform round it.
  slew.add(mesh([block(30, 30, 6, 0, 0, -3, 1), new CylinderGeometry(15, 15, 4, 28).rotateX(Math.PI / 2).translate(0, 0, -7)], m.dark));

  // The jib: a triangle in section, tapering to its tip, laced along its length.
  const jibParts: BufferGeometry[] = [];
  const chordY = 6.5;
  const depth = 13;
  const bays = Math.round(jib / 19);
  const taperAt = (x: number) => 1 - (x / jib) * 0.45;
  const topAt = (x: number) => depth * taperAt(x);
  jibParts.push(bar(v(0, -chordY, 0), v(jib, -chordY * taperAt(jib), 0), 1.05, 5));
  jibParts.push(bar(v(0, chordY, 0), v(jib, chordY * taperAt(jib), 0), 1.05, 5));
  jibParts.push(bar(v(0, 0, depth), v(jib, 0, topAt(jib)), 1.05, 5));
  for (let bay = 0; bay < bays; bay++) {
    const x0 = (bay / bays) * jib;
    const x1 = ((bay + 1) / bays) * jib;
    jibParts.push(bar(v(x0, -chordY * taperAt(x0), 0), v(x1, 0, topAt(x1)), 0.45, 4));
    jibParts.push(bar(v(x0, chordY * taperAt(x0), 0), v(x1, 0, topAt(x1)), 0.45, 4));
    jibParts.push(bar(v(x1, -chordY * taperAt(x1), 0), v(x1, chordY * taperAt(x1), 0), 0.45, 4));
  }
  slew.add(mesh(jibParts, m.yellow));

  // The counter-jib with its walkway, the counterweights and the winch.
  const counter = 112;
  const counterParts: BufferGeometry[] = [bar(v(0, -7, 0), v(-counter, -7, 0), 1.05, 5), bar(v(0, 7, 0), v(-counter, 7, 0), 1.05, 5)];
  for (let bay = 0; bay < 7; bay++) {
    const x = -(bay / 7) * counter;
    const next = -((bay + 1) / 7) * counter;
    counterParts.push(bar(v(x, -7, 0), v(next, 7, 0), 0.45, 4), bar(v(next, -7, 0), v(next, 7, 0), 0.45, 4));
  }
  slew.add(mesh(counterParts, m.yellow));
  slew.add(mesh([block(counter - 10, 12, 1, -counter / 2, 0, 1.2)], m.steel, false));
  slew.add(mesh(Array.from({ length: 4 }, (_, index) => block(9.4, 22, 24, -counter + 8 + index * 10.4, 0, -9, 0.8)), m.ballast));
  slew.add(mesh([block(20, 14, 11, -counter * 0.45, 0, 7, 1.5)], m.white));
  slew.add(mesh([block(2, 14.2, 3, -counter * 0.45 + 10.2, 0, 9, 0.2)], m.stripe, false));

  // The A-frame over the slewing ring and its pendant ties to both ends.
  const apex = 62;
  slew.add(mesh([bar(v(-7, -7, 0), v(0, 0, apex), 1.2), bar(v(-7, 7, 0), v(0, 0, apex), 1.2), bar(v(7, -7, 0), v(0, 0, apex), 1.2), bar(v(7, 7, 0), v(0, 0, apex), 1.2)], m.yellow));
  slew.add(mesh([bar(v(0, 0, apex), v(jib * 0.7, 0, topAt(jib * 0.7)), 0.32, 4), bar(v(0, 0, apex), v(jib * 0.36, 0, topAt(jib * 0.36)), 0.32, 4), bar(v(0, 0, apex), v(-counter * 0.95, 0, 0), 0.32, 4)], m.dark, false));

  // The operator's cab beside the root of the jib, glass to the front.
  const cab = new Group();
  cab.position.set(9, -15, -4);
  cab.add(mesh([block(17, 13, 15, 0, 0, 0, 2)], m.white));
  cab.add(mesh([block(4, 11.4, 9, 7.6, 0, 1.5, 1), block(12, 0.6, 7, 1, -6.6, 2, 0.2)], m.glass, false));
  slew.add(cab);

  const beaconMesh = new Mesh(new SphereGeometry(2.6, 14, 10), m.beacon);
  beaconMesh.position.set(0, 0, apex + 3);
  slew.add(beaconMesh);

  // The trolley under the jib, its two falls of rope and the hook block.
  const trolley = new Group();
  trolley.position.z = -2;
  slew.add(trolley);
  trolley.add(mesh([block(14, 12, 4, 0, 0, 0, 1), wheelAt(1.6, 1, -4, -6.6, 1.4), wheelAt(1.6, 1, 4, -6.6, 1.4)], m.dark));
  const ropeGeometry = new CylinderGeometry(0.32, 0.32, 1, 5).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const ropes = [-2.4, 2.4].map((y) => {
    const rope = new Mesh(ropeGeometry, m.dark);
    rope.position.y = y;
    trolley.add(rope);
    return rope;
  });
  const hook = new Group();
  hook.add(mesh([block(9, 6, 7, 0, 0, 0, 1.2)], m.yellow));
  hook.add(mesh([new TorusGeometry(2.2, 0.75, 6, 12, Math.PI * 1.4).rotateX(Math.PI / 2).translate(0, 0, -6.5), block(1.6, 1.6, 3, 0, 0, -4, 0)], m.steel));
  trolley.add(hook);
  let hanging: Group | null = null;
  const trolleyZ = height + trolley.position.z;

  return {
    root,
    height,
    jib,
    pose(heading, reach, hookZ) {
      slew.rotation.z = heading;
      trolley.position.x = Math.min(jib - 8, Math.max(26, reach));
      const drop = Math.max(6, trolleyZ - hookZ);
      for (const rope of ropes) rope.scale.z = drop - 4;
      hook.position.z = -drop;
    },
    hookAt(target) {
      root.updateMatrixWorld();
      return hook.getWorldPosition(target);
    },
    carry(load) {
      if (hanging === load) return;
      if (hanging) hook.remove(hanging);
      hanging = load;
      if (load) {
        load.position.set(0, 0, -12);
        hook.add(load);
      }
    },
    beacon(on, time) {
      m.beacon.emissiveIntensity = on ? 1.4 + 2.4 * Math.max(0, Math.sin(time * 4.6)) : 0;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Concrete pump truck
// -----------------------------------------------------------------------------------------

export interface PumpTruck {
  root: Group;
  /** Unfolds the boom so its hose hangs over a point (in the truck's own frame), or folds it away. */
  reach(target: Vector3 | null, time: number): void;
}

/** A truck facing +x: cab at the front, the boom's turret behind it, four outriggers down when it pumps. */
export function pumpTruck(m: MachineMaterials): PumpTruck {
  const root = new Group();
  root.userData.machine = 'pump';
  const body: BufferGeometry[] = [block(150, 30, 7, -6, 0, 13, 1), block(24, 30, 10, 47, 0, 21, 1.5)];
  root.add(mesh(body, m.dark));
  root.add(mesh([block(26, 30, 26, 70, 0, 27, 3.5), block(8, 31, 9, 78, 0, 14, 1.5)], m.white));
  root.add(mesh([block(3, 26, 11, 83.2, 0, 31, 0.8), block(16, 30.4, 9, 69, 0, 33, 1)], m.glass, false));
  root.add(mesh([block(56, 24, 14, -30, 0, 24, 2), block(20, 26, 16, -66, 0, 25, 2)], m.orange));
  // A cylinder stands along y, which is the axle of a truck facing +x.
  root.add(mesh([-60, -40, 30, 72].flatMap((x) => [-14, 14].map((y) => wheelAt(8, 7, x, y, 8))), m.rubber));
  const outriggers = new Group();
  root.add(outriggers);
  outriggers.add(
    mesh(
      [-34, 22].flatMap((x) => [-1, 1].flatMap((side) => [block(6, 30, 4, x, side * 30, 18), block(4, 4, 18, x, side * 44, 9), block(14, 14, 1.6, x, side * 44, 0.8)])),
      m.orange,
    ),
  );

  // The boom: four sections that fold over the truck and unfold toward the pour.
  const turret = new Group();
  turret.position.set(10, 0, 32);
  root.add(turret);
  turret.add(mesh([new CylinderGeometry(10, 11, 8, 24).rotateX(Math.PI / 2).translate(0, 0, 0), block(18, 14, 10, 0, 0, 8, 2)], m.orange));
  const lengths = [96, 92, 84, 70];
  const sizes = [8.5, 7, 5.6, 4.4];
  const joints: Group[] = [];
  let parent: Group = turret;
  lengths.forEach((length, index) => {
    const joint = new Group();
    joint.position.set(index === 0 ? 0 : lengths[index - 1]!, 0, index === 0 ? 12 : 0);
    parent.add(joint);
    const size = sizes[index]!;
    joint.add(mesh([block(length, size, size, length / 2, 0, 0, 1)], index % 2 === 0 ? m.white : m.paint));
    joint.add(mesh([block(length * 0.86, 1.6, 1.6, length / 2, 0, size / 2 + 0.8, 0.3)], m.dark, false));
    joints.push(joint);
    parent = joint;
  });
  const hoseGeometry = new CylinderGeometry(1.6, 1.6, 1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const hose = new Mesh(hoseGeometry, m.rubber);
  hose.castShadow = true;
  joints[3]!.add(hose);

  const folded = [0.08, Math.PI - 0.06, -(Math.PI - 0.1), Math.PI - 0.12];
  const local = new Vector3();

  return {
    root,
    reach(target, time) {
      outriggers.visible = true;
      if (!target) {
        turret.rotation.z = 0;
        joints.forEach((joint, index) => (joint.rotation.y = -folded[index]!));
        hose.visible = false;
        return;
      }
      hose.visible = true;
      local.copy(target).sub(turret.position);
      turret.rotation.z = Math.atan2(local.y, local.x);
      const out = Math.hypot(local.x, local.y);
      const [a, b, c, d] = lengths as [number, number, number, number];
      // The last section hangs steeply down to the hose; the others reach its root as a two-link arm over a raised first section.
      const tipUp = local.z + 26;
      const steep = 1.15;
      const wristOut = out - d * Math.cos(steep);
      const wristUp = tipUp + d * Math.sin(steep) - 12;
      const shoulder = 0.95 + 0.03 * Math.sin(time * 0.7);
      const elbowOut = a * Math.cos(shoulder);
      const elbowUp = a * Math.sin(shoulder);
      const dx = wristOut - elbowOut;
      const dz = wristUp - elbowUp;
      const span = Math.min(b + c - 0.5, Math.max(Math.abs(b - c) + 0.5, Math.hypot(dx, dz)));
      const toWrist = Math.atan2(dz, dx);
      const inner = Math.acos(Math.min(1, Math.max(-1, (b * b + span * span - c * c) / (2 * b * span))));
      const second = toWrist + inner;
      const kneeOut = elbowOut + b * Math.cos(second);
      const kneeUp = elbowUp + b * Math.sin(second);
      const third = Math.atan2(wristUp - kneeUp, wristOut - kneeOut);
      joints[0]!.rotation.y = -shoulder;
      joints[1]!.rotation.y = -(second - shoulder);
      joints[2]!.rotation.y = -(third - second);
      joints[3]!.rotation.y = -(-steep - third);
      // The hose hangs straight down from the tip.
      hose.position.set(d, 0, 0);
      hose.rotation.y = -joints.reduce((sum, joint) => sum + joint.rotation.y, 0);
      hose.scale.z = 22;
    },
  };
}

// -----------------------------------------------------------------------------------------
// Mixer truck
// -----------------------------------------------------------------------------------------

export interface MixerTruck {
  root: Group;
  spin(time: number): void;
}

export function mixerTruck(m: MachineMaterials): MixerTruck {
  const root = new Group();
  root.userData.machine = 'mixer';
  root.add(mesh([block(116, 26, 6, -4, 0, 12, 1)], m.dark));
  root.add(mesh([block(24, 28, 24, 54, 0, 26, 3.5), block(7, 29, 8, 64, 0, 13, 1.5)], m.white));
  root.add(mesh([block(3, 24, 10, 66.2, 0, 30, 0.8), block(14, 28.4, 8, 53, 0, 32, 1)], m.glass, false));
  const tires = mesh(
    [-46, -28, 44].flatMap((x) => [-12.5, 12.5].map((y) => new CylinderGeometry(7.5, 7.5, 6, 20).translate(x, y, 7.5))),
    m.rubber,
  );
  root.add(tires);
  // The drum leans back toward its chute, and turns all the time it carries concrete.
  const cradle = new Group();
  cradle.position.set(-10, 0, 33);
  cradle.rotation.y = -0.2;
  root.add(cradle);
  const drum = new Group();
  cradle.add(drum);
  const shell = new CylinderGeometry(9, 15, 34, 24, 1, false).rotateZ(Math.PI / 2).translate(8, 0, 0);
  const tail = new CylinderGeometry(15, 6, 26, 24, 1, false).rotateZ(Math.PI / 2).translate(-22, 0, 0);
  // A painted spiral on the drum, which shows it turning.
  drum.add(mesh([shell, tail], drumPaint(m)));
  root.add(mesh([block(14, 6, 3, -52, 0, 22, 0.5).rotateY(0.5)], m.steel, false));
  return {
    root,
    spin(time) {
      drum.rotation.x = time * 1.6;
    },
  };
}

const drumPaints = new WeakMap<MachineMaterials, MeshStandardMaterial>();
function drumPaint(m: MachineMaterials): MeshStandardMaterial {
  let material = drumPaints.get(m);
  if (material) return material;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = '#e4e1da';
  paint.fillRect(0, 0, 128, 128);
  paint.strokeStyle = '#d0603a';
  paint.lineWidth = 14;
  for (let x = -128; x < 256; x += 48) {
    paint.beginPath();
    paint.moveTo(x, 0);
    paint.lineTo(x + 128, 128);
    paint.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  material = new MeshStandardMaterial({ map: texture, roughness: 0.4, metalness: 0.3 });
  drumPaints.set(m, material);
  return material;
}

// -----------------------------------------------------------------------------------------
// Scissor lift
// -----------------------------------------------------------------------------------------

export interface ScissorLift {
  root: Group;
  /** Raises the platform's deck to this height above the floor. */
  rise(deck: number): void;
}

export function scissorLift(m: MachineMaterials): ScissorLift {
  const root = new Group();
  root.userData.machine = 'lift';
  root.add(mesh([block(32, 15, 6, 0, 0, 6, 1.2), block(8, 13, 4, -11, 0, 11, 1)], m.orange));
  root.add(mesh([-10, 10].flatMap((x) => [-7.5, 7.5].map((y) => new CylinderGeometry(3, 3, 2.6, 16).translate(x, y, 3))), m.rubber));
  const scissor = new Group();
  root.add(scissor);
  const arms: Mesh[] = [];
  const armGeometry = new BoxGeometry(28, 1.2, 1.6);
  for (let stage = 0; stage < 4; stage++) {
    for (const y of [-6, 6]) {
      for (const turn of [1, -1]) {
        const arm = new Mesh(armGeometry, m.dark);
        arm.castShadow = true;
        arm.userData.stage = stage;
        arm.userData.turn = turn;
        arm.position.y = y;
        scissor.add(arm);
        arms.push(arm);
      }
    }
  }
  const platform = new Group();
  root.add(platform);
  platform.add(mesh([block(34, 15, 2.4, 0, 0, 0, 0.6)], m.orange));
  const rails: BufferGeometry[] = [];
  const corners = [v(-16.5, -7, 1), v(16.5, -7, 1), v(16.5, 7, 1), v(-16.5, 7, 1)];
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % 4]!;
    rails.push(bar(corner, v(corner.x, corner.y, 13), 0.45, 4), bar(v(corner.x, corner.y, 13), v(next.x, next.y, 13), 0.45, 4), bar(v(corner.x, corner.y, 7), v(next.x, next.y, 7), 0.35, 4));
  });
  platform.add(mesh(rails, m.yellow, false));
  return {
    root,
    rise(deck) {
      const lowest = 12;
      const height = Math.max(lowest, deck);
      const each = (height - lowest + 4) / 4;
      const angle = Math.asin(Math.min(0.95, each / 28));
      for (const arm of arms) {
        const stage = arm.userData.stage as number;
        arm.position.z = 10 + each * (stage + 0.5);
        arm.rotation.y = (arm.userData.turn as number) * angle;
      }
      platform.position.z = height;
    },
  };
}
