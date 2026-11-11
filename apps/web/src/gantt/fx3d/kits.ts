/**
 * Scale models of the work. A kit is built once from a task's facts, then `update` poses it from how
 * far the work has come, so the ruler can scrub it both ways and nothing depends on the path taken.
 * A model stands on a plate of `PLATE.width` by `PLATE.depth` centered on the kit's origin.
 */
import { BoxGeometry, BufferGeometry, Color, ExtrudeGeometry, Group, InstancedMesh, type Material, Matrix4, Mesh, MeshStandardMaterial, Object3D, Path, Shape, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TaskFacts } from './facts';
import type { PropKit } from './props';
import { box, clamp01, easeOut, excavator, figure, iSection, keyed, lerp, type Materials, member, pumpTruck, realExcavator, roundBox, scissorLift, smooth, solid, strut, towerCrane, upright, within } from './parts';

/** The band of plate in front of the model that keeps the ruler and the task's name in view. */
export const PLATE = { width: 600, depth: 420, thickness: 14, frontBand: 30 };

export interface KitState {
  /** 0 before the work starts, 1 once it is finished. */
  work: number;
  /** A machine is on site and the work has not begun. */
  idle: boolean;
  /** Seconds, for what keeps moving on its own. */
  time: number;
}

export interface Kit {
  root: Group;
  /** How tall the model stands, for framing it. */
  height: number;
  update(state: KitState): void;
}

// -----------------------------------------------------------------------------------------
// Pieces that arrive one after another
// -----------------------------------------------------------------------------------------

interface Piece {
  mesh: Object3D;
  home: Vector3;
  /** Where it comes from, relative to home. */
  from: Vector3;
  start: number;
  end: number;
}

function piece(mesh: Object3D, from: Vector3): Piece {
  return { mesh, home: mesh.position.clone(), from, start: 0, end: 1 };
}

/** Spreads pieces over the span from 0 to 1, each overlapping the next by `overlap` of its own time. */
function inSequence(pieces: readonly Piece[], overlap = 0.5): void {
  const each = 1 / (pieces.length * (1 - overlap) + overlap);
  pieces.forEach((item, index) => {
    item.start = index * each * (1 - overlap);
    item.end = item.start + each;
  });
}

function placePieces(pieces: readonly Piece[], work: number): void {
  for (const item of pieces) {
    const t = within(work, item.start, item.end);
    item.mesh.visible = t > 0;
    if (t <= 0) continue;
    const eased = easeOut(t);
    item.mesh.position.copy(item.home).addScaledVector(item.from, 1 - eased);
  }
}

// -----------------------------------------------------------------------------------------
// The steel frame every structural model shares
// -----------------------------------------------------------------------------------------

const BAY = 64;
const STOREY = 60;
const BAYS_X = 3;
const BAYS_Y = 2;
const FRAME_X = 16;
const STOREYS = 2;

interface Member {
  mesh: Mesh;
  home: Vector3;
  middle: Vector3;
}

/** Members in the order they go up: lifted together as picks, one line of the grid at a time. */
function steelFrame(m: Materials, parent: Group): { picks: Member[][]; joints: Vector3[] } {
  const column = iSection(7.5);
  const beam = iSection(5.5);
  const at = (ix: number, iy: number, level: number) =>
    new Vector3(FRAME_X + (ix - BAYS_X / 2) * BAY, (iy - BAYS_Y / 2) * BAY, level * STOREY);
  const make = (section: BufferGeometry, a: Vector3, b: Vector3): Member => {
    const mesh = member(section, m.steel, a, b);
    parent.add(mesh);
    return { mesh, home: a.clone(), middle: new Vector3().addVectors(a, b).multiplyScalar(0.5) };
  };
  const picks: Member[][] = [];
  const joints: Vector3[] = [];
  for (let level = 0; level < STOREYS; level++) {
    for (let iy = 0; iy <= BAYS_Y; iy++) {
      const pick: Member[] = [];
      for (let ix = 0; ix <= BAYS_X; ix++) pick.push(make(column, at(ix, iy, level), at(ix, iy, level + 1)));
      picks.push(pick);
    }
    for (let iy = 0; iy <= BAYS_Y; iy++) {
      const pick: Member[] = [];
      for (let ix = 0; ix < BAYS_X; ix++) {
        pick.push(make(beam, at(ix, iy, level + 1), at(ix + 1, iy, level + 1)));
        joints.push(at(ix, iy, level + 1));
      }
      joints.push(at(BAYS_X, iy, level + 1));
      picks.push(pick);
    }
    for (let line = 0; line <= BAYS_X; line += 2) {
      const pick: Member[] = [];
      for (let ix = line; ix <= Math.min(line + 1, BAYS_X); ix++) {
        for (let iy = 0; iy < BAYS_Y; iy++) pick.push(make(beam, at(ix, iy, level + 1), at(ix, iy + 1, level + 1)));
      }
      picks.push(pick);
    }
  }
  return { picks, joints };
}

function anchorPlates(m: Materials, parent: Group): void {
  for (let ix = 0; ix <= BAYS_X; ix++) {
    for (let iy = 0; iy <= BAYS_Y; iy++) {
      parent.add(solid(box(20, 20, 3), m.concrete, FRAME_X + (ix - BAYS_X / 2) * BAY, (iy - BAYS_Y / 2) * BAY, 1.5));
    }
  }
}

function addCrew(m: Materials, parent: Group, facts: TaskFacts, spots: readonly (readonly [number, number])[], scale = 1.35): void {
  const colors = facts.crews.length > 0 ? facts.crews.map((crew) => crew.color) : ['#46576c'];
  spots.forEach(([x, y], index) => {
    const person = figure(m, colors[index % colors.length]!, index * 1.7);
    person.position.set(x, y, 0);
    person.scale.setScalar(scale);
    parent.add(person);
  });
}

// -----------------------------------------------------------------------------------------
// Steel: the crane lifts the frame into place, pick by pick
// -----------------------------------------------------------------------------------------

function steelKit(m: Materials, facts: TaskFacts): Kit {
  const root = new Group();
  anchorPlates(m, root);
  const framed = new Group();
  root.add(framed);
  const { picks, joints } = steelFrame(m, framed);
  const delivering = /deliver|lay-?down/i.test(facts.name);
  const boltingUp = /bolt|inspect/i.test(facts.name);
  const hasCrane = facts.machines.includes('crane');

  // The steel waiting on the ground.
  const pile = new Group();
  pile.position.set(-118, -112, 0);
  root.add(pile);
  // Where those who carry from the pile stand, at its middle.
  const carryFrom = new Group();
  carryFrom.position.set(65, 0, 0);
  carryFrom.userData.stock = true;
  pile.add(carryFrom);
  const stack: Mesh[] = [];
  const stick = iSection(6);
  for (let layer = 0; layer < 5; layer++) {
    for (let index = 0; index < 8 - layer; index++) {
      const bar = member(stick, m.steel, new Vector3(0, index * 9 + layer * 4.5 - 30, 3.5 + layer * 7.2), new Vector3(130, index * 9 + layer * 4.5 - 30, 3.5 + layer * 7.2));
      pile.add(bar);
      stack.push(bar);
    }
  }
  [10, 120].forEach((x) => pile.add(solid(box(8, 80, 3), m.timber, x, 0, 1.5)));
  const stackFill = (share: number) => stack.forEach((bar, index) => (bar.visible = index < Math.round(stack.length * share)));

  addCrew(m, root, facts, [[-125, -60], [-140, -74], [160, -110], [186, 96], [-48, 98]]);

  // Bolts, for the inspection.
  const bolts = joints.map((joint) => {
    const bolt = solid(new BoxGeometry(9, 9, 9), m.bolt, joint.x, joint.y, joint.z);
    bolt.visible = false;
    framed.add(bolt);
    return bolt;
  });

  const craneBase = { x: -212, y: 74 };
  const crane = hasCrane ? towerCrane(m) : null;
  if (crane) {
    crane.root.position.set(craneBase.x, craneBase.y, 0);
    root.add(crane.root);
  }
  const polar = (x: number, y: number) => {
    const dx = x - craneBase.x;
    const dy = y - craneBase.y;
    return { az: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
  };
  const parking = { az: -0.3, radius: 60, z: 240 };
  const pickup = polar(pile.position.x + 60, pile.position.y);
  const centers = picks.map((pick) => pick.reduce((sum, item) => sum.add(item.middle), new Vector3()).multiplyScalar(1 / pick.length));
  const span = 1 / picks.length;

  return {
    root,
    height: crane ? crane.height + 90 : 150,
    update({ work, idle, time }) {
      if (delivering) {
        framed.visible = false;
        stackFill(work);
        return;
      }
      if (boltingUp) {
        pile.visible = false;
        for (const pick of picks) for (const item of pick) item.mesh.visible = true;
        bolts.forEach((bolt, index) => {
          const t = within(work, index / bolts.length, (index + 2) / bolts.length);
          bolt.visible = t > 0;
          bolt.scale.setScalar(0.3 + 0.7 * easeOut(t));
        });
        return;
      }
      // It runs down as the frame goes up, and nothing is left lying around after.
      pile.visible = work < 0.99;
      stackFill(1 - work * 0.85);
      let hook = { az: parking.az, radius: parking.radius, z: parking.z };
      picks.forEach((pick, index) => {
        const u = within(work, index * span, (index + 1) * span);
        const center = centers[index]!;
        const target = polar(center.x, center.y);
        const above = center.z + 46;
        if (u > 0 && u < 1) {
          const previous = index === 0 ? parking : { ...polar(centers[index - 1]!.x, centers[index - 1]!.y), z: centers[index - 1]!.z + 46 };
          const [az, radius, z] = keyed(u, [
            [0, [previous.az, previous.radius, previous.z]],
            [0.28, [pickup.az, pickup.radius, 44]],
            [0.68, [target.az, target.radius, above + 20]],
            [1, [target.az, target.radius, above]],
          ]) as [number, number, number];
          hook = { az, radius, z };
        } else if (u >= 1) {
          hook = { az: target.az, radius: target.radius, z: above };
        }
        // On the hook it hangs as a tight bundle; over its place the bundle opens out.
        const hookX = craneBase.x + hook.radius * Math.cos(hook.az);
        const hookY = craneBase.y + hook.radius * Math.sin(hook.az);
        const spread = 0.22 + 0.78 * smooth(within(u, 0.72, 1));
        const riding = within(u, 0.3, 0.72);
        for (const item of pick) {
          item.mesh.visible = u >= 0.3 || u >= 1;
          if (u >= 1) {
            item.mesh.position.copy(item.home);
            continue;
          }
          const hungX = hookX + (item.middle.x - center.x) * spread;
          const hungY = hookY + (item.middle.y - center.y) * spread;
          const hungZ = hook.z - 22 + (item.middle.z - center.z) * spread;
          const settle = smooth(within(u, 0.86, 1));
          item.mesh.position.set(
            lerp(hungX + (item.home.x - item.middle.x), item.home.x, settle),
            lerp(hungY + (item.home.y - item.middle.y), item.home.y, settle),
            lerp(hungZ + (item.home.z - item.middle.z), item.home.z, settle),
          );
          if (riding <= 0) item.mesh.visible = false;
        }
      });
      if (crane) {
        // Standing idle the jib only drifts with the wind, the hook drawn up: nothing is being lifted.
        if (idle) crane.pose(parking.az + Math.sin(time * 0.35) * 0.05, parking.radius, parking.z);
        else if (work >= 1) crane.pose(hook.az, lerp(hook.radius, parking.radius, 0.2), hook.z + 40);
        else crane.pose(hook.az, hook.radius, hook.z);
        crane.beacon(idle, time);
      }
    },
  };
}

// -----------------------------------------------------------------------------------------
// Concrete: the pump's boom moves from footing to footing
// -----------------------------------------------------------------------------------------

function concreteKit(m: Materials, facts: TaskFacts): Kit {
  const root = new Group();
  const SOIL = 24;
  const pad = 82;
  const spots: [number, number][] = [];
  for (const y of [-74, 74]) for (const x of [-46, 62, 170]) spots.push([x, y]);

  const shape = new Shape();
  shape.moveTo(-120, -160);
  shape.lineTo(270, -160);
  shape.lineTo(270, 160);
  shape.lineTo(-120, 160);
  shape.closePath();
  for (const [x, y] of spots) {
    const hole = new Path();
    hole.moveTo(x - pad / 2, y - pad / 2);
    hole.lineTo(x - pad / 2, y + pad / 2);
    hole.lineTo(x + pad / 2, y + pad / 2);
    hole.lineTo(x + pad / 2, y - pad / 2);
    hole.closePath();
    shape.holes.push(hole);
  }
  root.add(solid(new ExtrudeGeometry(shape, { depth: SOIL, bevelEnabled: false }), m.soil));

  const backfilling = /backfill|cure/i.test(facts.name);
  const fills = spots.map(([x, y]) => {
    const cage: BufferGeometry[] = [];
    for (let i = -2; i <= 2; i++) {
      for (const level of [5, 17]) {
        cage.push(strut(new Vector3(x + i * 15, y - 34, level), new Vector3(x + i * 15, y + 34, level), 0.7, 4));
        cage.push(strut(new Vector3(x - 34, y + i * 15, level), new Vector3(x + 34, y + i * 15, level), 0.7, 4));
      }
      for (const j of [-2, 2]) {
        cage.push(strut(new Vector3(x + i * 15, y + j * 15, 2), new Vector3(x + i * 15, y + j * 15, 30), 0.7, 4));
      }
    }
    const rebar = solid(mergeGeometries(cage), m.rebar);
    root.add(rebar);
    const wet = new MeshStandardMaterial({ color: '#54595d', roughness: 0.12 });
    const fill = solid(box(pad, pad, 1), wet, x, y, 0);
    fill.geometry.translate(0, 0, 0.5);
    root.add(fill);
    return { x, y, fill, wet, rebar };
  });
  const dry = new Color('#bcc0c1');
  const wetColor = new Color('#54595d');

  const hasPump = facts.machines.includes('pump');
  const pump = hasPump ? pumpTruck(m) : null;
  const turret = { x: -205, y: 0 };
  if (pump) {
    pump.root.position.set(turret.x, turret.y, 0);
    root.add(pump.root);
  }
  const people = new Group();
  people.position.z = SOIL;
  root.add(people);
  addCrew(m, people, facts, [[-104, -130], [8, 0], [116, 0], [228, 12], [40, 138]]);

  const order = [0, 1, 2, 5, 4, 3];
  const span = 1 / order.length;

  return {
    root,
    height: 210,
    update({ work, time }) {
      let tipX = -60;
      let tipY = -46;
      let tipZ = 64;
      order.forEach((index, turn) => {
        const item = fills[index]!;
        const u = within(work, turn * span, (turn + 1) * span);
        const level = backfilling ? 1 : smooth(within(u, 0.18, 0.92));
        item.fill.visible = level > 0;
        item.fill.scale.z = Math.max(0.01, level * (SOIL - 1));
        item.rebar.visible = level < 0.98;
        // Wet and dark as it goes in, pale once it has cured.
        const age = backfilling ? work : within(work, (turn + 1) * span, Math.min(1.25, (turn + 3.5) * span));
        item.wet.color.lerpColors(wetColor, dry, age);
        item.wet.roughness = lerp(0.12, 0.94, age);
        if (u > 0 && u < 1) {
          const sweep = Math.sin(time * 2.6) * 18;
          const previous = fills[order[turn - 1] ?? 0]!;
          const arrive = smooth(within(u, 0, 0.18));
          tipX = lerp(previous.x, item.x + sweep, arrive);
          tipY = lerp(previous.y, item.y + Math.cos(time * 1.9) * 14, arrive);
          tipZ = lerp(58, 36, arrive);
        } else if (u >= 1) {
          tipX = item.x;
          tipY = item.y;
          tipZ = 58;
        }
      });
      pump?.reach(tipX - turret.x, tipY - turret.y, tipZ);
    },
  };
}

// -----------------------------------------------------------------------------------------
// Earth: an excavator digs a stepped pit and piles what comes out
// -----------------------------------------------------------------------------------------

function earthKit(m: Materials, facts: TaskFacts, props: PropKit | null): Kit {
  const root = new Group();
  const cell = 24;
  const columns = 22;
  const rows = 12;
  const ground = 34;
  const rim = { x: 48, y: 118 };
  const cells: { x: number; y: number; depth: number; heap: number; digAt: number }[] = [];
  for (let ix = 0; ix < columns; ix++) {
    for (let iy = 0; iy < rows; iy++) {
      const x = (ix - columns / 2 + 0.5) * cell;
      const y = (iy - rows / 2 + 0.5) * cell;
      const inPitX = within(x, 196, 130) * within(x, -128, -62);
      const inPitY = within(y, 84, 42) * within(y, -130, -82);
      const heapDistance = Math.hypot((x + 136) / 1.1, (y - 100) / 0.72);
      const heap = Math.max(0, 1 - heapDistance / 84);
      cells.push({
        x,
        y,
        depth: smooth(inPitX * inPitY) * 28,
        heap: smooth(heap) * 58,
        digAt: within(y, 84, -130) * 0.72 + within(Math.abs(x - 34), 160, 0) * 0.1,
      });
    }
  }
  const geometry = new BoxGeometry(cell - 0.5, cell - 0.5, 1);
  geometry.translate(0, 0, 0.5);
  const soil = new InstancedMesh(geometry, m.soilGrain, cells.length);
  soil.castShadow = true;
  soil.receiveShadow = true;
  root.add(soil);
  const dummy = new Object3D();
  const topsoil = new Color('#8d8c58');
  const cut = new Color('#b4966c');
  const deep = new Color('#8f7350');
  const tone = new Color();

  const machine = realExcavator(props) ?? excavator(m);
  machine.root.position.set(rim.x, rim.y, ground);
  root.add(machine.root);
  const people = new Group();
  people.position.z = ground;
  root.add(people);
  addCrew(m, people, facts, [[-240, -116], [-214, -128], [244, -104]]);

  return {
    root,
    height: 170,
    update({ work, time }) {
      cells.forEach((item, index) => {
        const dug = smooth(within(work, item.digAt, item.digAt + 0.18));
        const heaped = smooth(within(work, 0.05, 0.98));
        const height = ground - item.depth * dug + item.heap * heaped;
        dummy.position.set(item.x, item.y, 0);
        dummy.scale.set(1, 1, Math.max(1, height));
        dummy.updateMatrix();
        soil.setMatrixAt(index, dummy.matrix);
        const exposed = clamp01((item.depth * dug) / 24);
        if (item.heap * heaped > 2) tone.copy(cut);
        else if (exposed > 0.04) tone.copy(cut).lerp(deep, exposed);
        else tone.copy(topsoil);
        soil.setColorAt(index, tone);
      });
      soil.instanceMatrix.needsUpdate = true;
      if (soil.instanceColor) soil.instanceColor.needsUpdate = true;
      const digging = work > 0 && work < 1;
      const cycle = digging ? (time * 0.42) % 1 : 0.05;
      machine.root.position.x = rim.x + Math.sin(work * Math.PI * 3) * 26;
      const [yaw, boom, stick, bucket] = keyed(cycle, [
        [0, [-1.75, 0.08, 0.75, 0.3]],
        [0.3, [-1.75, -0.28, 1.35, 1.45]],
        [0.42, [-1.75, 0.28, 1.15, 1.7]],
        [0.62, [-3.15, 0.46, 0.85, 1.55]],
        [0.74, [-3.15, 0.46, 0.5, -0.3]],
        [1, [-1.75, 0.08, 0.75, 0.3]],
      ]) as [number, number, number, number];
      machine.pose(yaw, boom, -stick, -bucket);
    },
  };
}

// -----------------------------------------------------------------------------------------
// Envelope: the finished frame takes its roof, wall panels and glass
// -----------------------------------------------------------------------------------------

function envelopeKit(m: Materials, facts: TaskFacts): Kit {
  const root = new Group();
  anchorPlates(m, root);
  const { picks } = steelFrame(m, root);
  for (const pick of picks) for (const item of pick) item.mesh.position.copy(item.home);
  const layer = /roof/i.test(facts.name) ? 0 : /window|door/i.test(facts.name) ? 2 : 1;

  const width = BAYS_X * BAY;
  const deep = BAYS_Y * BAY;
  const left = FRAME_X - width / 2;
  const front = -deep / 2;
  const top = STOREYS * STOREY;

  const deck: Piece[] = [];
  const strips = 12;
  for (let i = 0; i < strips; i++) {
    const strip = solid(box(width / strips - 1, deep + 8, 2.4), m.deck, left + (i + 0.5) * (width / strips), 0, top + 3.5);
    root.add(strip);
    deck.push(piece(strip, new Vector3(0, 0, 80)));
  }
  inSequence(deck, 0.6);

  // Each bay of each face: panel above and below a band left open for the window.
  const walls: Piece[] = [];
  const glass: Piece[] = [];
  const liftStops: { x: number; y: number; z: number }[] = [];
  const addFace = (origin: Vector3, along: Vector3, outward: Vector3, bays: number) => {
    for (let level = 0; level < STOREYS; level++) {
      for (let bay = 0; bay < bays; bay++) {
        const center = origin.clone().addScaledVector(along, (bay + 0.5) * BAY).add(new Vector3(0, 0, level * STOREY)).addScaledVector(outward, 5);
        const wide = along.x !== 0;
        const make = (height: number, z: number, material: Material, thickness: number) => {
          const geometry = wide ? box(BAY - 1, thickness, height) : box(thickness, BAY - 1, height);
          return solid(geometry, material, center.x, center.y, center.z + z);
        };
        const lower = make(20, 11, m.panel, 3.6);
        const upper = make(14, 52, m.panel, 3.6);
        const pane = make(24, 34, m.glass, 1.6);
        pane.castShadow = false;
        root.add(lower, upper, pane);
        const from = outward.clone().multiplyScalar(46);
        walls.push(piece(lower, from), piece(upper, from));
        glass.push(piece(pane, from));
        liftStops.push({ x: center.x + outward.x * 42, y: center.y + outward.y * 42, z: center.z + 6 });
      }
    }
  };
  addFace(new Vector3(left + width, -front, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), BAYS_X);
  addFace(new Vector3(left + width, front, 0), new Vector3(0, 1, 0), new Vector3(1, 0, 0), BAYS_Y);
  addFace(new Vector3(left, -front, 0), new Vector3(0, -1, 0), new Vector3(-1, 0, 0), BAYS_Y);
  addFace(new Vector3(left, front, 0), new Vector3(1, 0, 0), new Vector3(0, -1, 0), BAYS_X);
  inSequence(walls, 0.45);
  inSequence(glass, 0.45);

  const lift = facts.machines.includes('lift') || layer === 1 ? scissorLift(m) : null;
  if (lift) root.add(lift.root);
  addCrew(m, root, facts, [[-180, -120], [-158, -132], [-196, 40], [200, -120]]);

  return {
    root,
    height: 170,
    update({ work, idle }) {
      placePieces(deck, layer === 0 ? work : 1);
      placePieces(walls, layer === 1 ? work : layer > 1 ? 1 : 0);
      placePieces(glass, layer === 2 ? work : 0);
      if (lift && idle) {
        // Booked with nothing to do: lowered and parked out in front, where it can be seen doing nothing.
        lift.root.position.set(left + width * 0.2, front - 62, 0);
        lift.rise(8);
      } else if (lift) {
        const moving = layer === 2 ? 1 : work;
        const position = moving * (liftStops.length - 1);
        const index = Math.min(liftStops.length - 2, Math.floor(position));
        const a = liftStops[index]!;
        const b = liftStops[index + 1]!;
        const t = smooth(position - index);
        lift.root.position.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), 0);
        lift.rise(Math.max(8, lerp(a.z, b.z, t) - 14));
      }
    },
  };
}

// -----------------------------------------------------------------------------------------
// Interior: a cutaway room, one trade's layer after another
// -----------------------------------------------------------------------------------------

function interiorKit(m: Materials, facts: TaskFacts): Kit {
  const root = new Group();
  const w = 440;
  const d = 300;
  const h = 128;
  const xLeft = -w / 2;
  const yBack = d / 2;
  root.add(solid(box(w + 12, d + 12, 8), m.concrete, 0, 0, 4));
  const floorZ = 8;

  const studs: BufferGeometry[] = [];
  for (let x = xLeft; x <= -xLeft; x += 24) studs.push(new BoxGeometry(3, 5, h).translate(x, yBack, floorZ + h / 2));
  for (let y = -d / 2; y <= yBack; y += 24) studs.push(new BoxGeometry(5, 3, h).translate(xLeft, y, floorZ + h / 2));
  studs.push(new BoxGeometry(w, 5, 3).translate(0, yBack, floorZ + h));
  studs.push(new BoxGeometry(w, 5, 3).translate(0, yBack, floorZ + 1.5));
  studs.push(new BoxGeometry(5, d, 3).translate(xLeft, 0, floorZ + h));
  studs.push(new BoxGeometry(5, d, 3).translate(xLeft, 0, floorZ + 1.5));
  root.add(solid(mergeGeometries(studs), m.stud));

  const roughIn: Piece[] = [];
  const hung = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number) => {
    const mesh = solid(geometry, material, x, y, z);
    root.add(mesh);
    roughIn.push(piece(mesh, new Vector3(0, 0, 40)));
  };
  for (let i = 0; i < 6; i++) hung(box(66, 30, 22), m.duct, xLeft + 44 + i * 70, 104, floorZ + h - 12);
  for (let i = 0; i < 3; i++) hung(box(30, 52, 16), m.duct, xLeft + 94 + i * 140, 62, floorZ + h - 10);
  for (let i = 0; i < 2; i++) hung(box(w - 30, 4, 4), i === 0 ? m.copper : m.pipe, 8, 136 - i * 9, floorZ + h - 7 - i * 4);
  for (let i = 0; i < 4; i++) hung(box(4, 4, h - 10), i % 2 === 0 ? m.copper : m.pipe, xLeft + 80 + i * 92, yBack - 6, floorZ + (h - 10) / 2);
  inSequence(roughIn, 0.55);

  const paintable: MeshStandardMaterial[] = [];
  const boards: Piece[] = [];
  const addBoard = (geometry: BufferGeometry, x: number, y: number, z: number, from: Vector3, index: number) => {
    const material = new MeshStandardMaterial({ color: '#cfcfc8', roughness: 0.9 });
    paintable[index] = material;
    const board = solid(geometry, material, x, y, z);
    root.add(board);
    boards.push(piece(board, from));
  };
  let boardIndex = 0;
  for (let i = 0; i < 6; i++) addBoard(box(w / 6 - 0.6, 4, h), xLeft + (i + 0.5) * (w / 6), yBack - 4, floorZ + h / 2, new Vector3(0, -48, 0), boardIndex++);
  for (let i = 0; i < 4; i++) addBoard(box(4, d / 4 - 0.6, h), xLeft + 4, -d / 2 + (i + 0.5) * (d / 4), floorZ + h / 2, new Vector3(48, 0, 0), boardIndex++);
  inSequence(boards, 0.5);

  const painted = new Color('#ece7da');
  const bare = new Color('#c9c9c1');

  const tiles: Piece[] = [];
  const tileMaterials = [new MeshStandardMaterial({ color: '#a7b5b4', roughness: 0.32 }), new MeshStandardMaterial({ color: '#b9c5c3', roughness: 0.32 })];
  for (let ix = 0; ix < 12; ix++) {
    for (let iy = 0; iy < 8; iy++) {
      const tile = solid(box(w / 12 - 0.9, d / 8 - 0.9, 2), tileMaterials[(ix + iy) % 2]!, xLeft + 8 + (ix + 0.5) * ((w - 8) / 12), -d / 2 + (iy + 0.5) * ((d - 6) / 8), floorZ + 1);
      tile.castShadow = false;
      root.add(tile);
      tiles.push(piece(tile, new Vector3(0, 0, 30)));
    }
  }
  inSequence(tiles, 0.7);

  const fitted: Piece[] = [];
  const place = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number) => {
    const mesh = solid(geometry, material, x, y, z);
    root.add(mesh);
    fitted.push(piece(mesh, new Vector3(0, 0, 90)));
  };
  place(roundBox(136, 26, 44, 2), m.white, -96, yBack - 22, floorZ + 24);
  place(roundBox(144, 30, 3, 1), m.timber, -96, yBack - 22, floorZ + 48);
  place(roundBox(136, 16, 30, 2), m.white, -96, yBack - 15, floorZ + 90);
  place(roundBox(92, 40, 22, 3), m.panel, 44, 8, floorZ + 26);
  place(roundBox(96, 42, 5, 2), m.pipe, 44, 8, floorZ + 40);
  place(upright(13, 18, 16), m.machineDark, -40, -30, floorZ + 2);
  place(roundBox(24, 24, 5, 2), m.pipe, -40, -30, floorZ + 22);
  place(roundBox(70, 30, 2, 0.5), m.white, 40, 8, floorZ + h - 2);
  place(roundBox(70, 30, 2, 0.5), m.white, -110, 8, floorZ + h - 2);
  inSequence(fitted, 0.35);

  const checks: Piece[] = [];
  [[-140, 90], [-60, 60], [30, 90], [120, 60], [170, -10], [60, -60], [-40, -90], [-150, -40]].forEach(([x, y]) => {
    const flag = new Group();
    const mesh = solid(box(1.2, 1.2, 30), m.machineDark, x!, y!, floorZ + 15);
    const banner = solid(box(13, 1, 8), m.ok, x! + 7, y!, floorZ + 26);
    flag.add(mesh, banner);
    root.add(mesh, banner);
    checks.push(piece(mesh, new Vector3(0, 0, 40)), piece(banner, new Vector3(0, 0, 40)));
  });
  inSequence(checks, 0.5);

  addCrew(m, root, facts, [[-30, -110], [20, -128], [130, -104], [168, 60]], 3.1);

  const stage = /rough/i.test(facts.name)
    ? 1
    : /drywall|tape/i.test(facts.name)
      ? 2
      : /paint/i.test(facts.name)
        ? 3
        : /floor/i.test(facts.name)
          ? 4
          : /fit-?out|exam/i.test(facts.name)
            ? 5
            : /commission|punch|handover/i.test(facts.name)
              ? 6
              : 1;

  const share = (layer: number, work: number) => (stage > layer ? 1 : stage === layer ? work : 0);

  return {
    root,
    height: 160,
    update({ work }) {
      placePieces(roughIn, share(1, work));
      placePieces(boards, share(2, work));
      const paint = share(3, work);
      paintable.forEach((material, index) => material.color.lerpColors(bare, painted, within(paint, (index / paintable.length) * 0.8, (index / paintable.length) * 0.8 + 0.2)));
      placePieces(tiles, share(4, work));
      placePieces(fitted, share(5, work));
      placePieces(checks, share(6, work));
    },
  };
}

// -----------------------------------------------------------------------------------------
// Site setup: the fence goes round, and the cabins are set down
// -----------------------------------------------------------------------------------------

function siteKit(m: Materials, facts: TaskFacts, props: PropKit | null): Kit {
  const root = new Group();
  const w = PLATE.width - 36;
  const d = PLATE.depth - 36;
  root.add(solid(box(w - 4, d - 4, 2), m.gravel, 0, 0, 1));
  const posts: Piece[] = [];
  const spacing = 34;
  const corners: [number, number][] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const fence = new MeshStandardMaterial({ color: '#7f8a90', metalness: 0.5, roughness: 0.5, transparent: true, opacity: 0.45 });
  corners.forEach(([x, y], index) => {
    const [nx, ny] = corners[(index + 1) % 4]!;
    const length = Math.hypot(nx - x, ny - y);
    const count = Math.round(length / spacing);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const px = lerp(x, nx, t);
      const py = lerp(y, ny, t);
      const post = solid(upright(1.4, 42, 8), m.machineDark, lerp(x, nx, i / count), lerp(y, ny, i / count), 0);
      root.add(post);
      posts.push(piece(post, new Vector3(0, 0, 60)));
      const sideways = nx === x;
      const panel = solid(sideways ? box(0.7, length / count - 2, 36) : box(length / count - 2, 0.7, 36), fence, px, py, 22);
      root.add(panel);
      posts.push(piece(panel, new Vector3(0, 0, 60)));
    }
  });
  inSequence(posts, 0.8);

  const cabins: Piece[] = [];
  const addCabin = (x: number, y: number, z: number, color: Material) => {
    const body = solid(roundBox(96, 34, 32, 1.5), color, x, y, z + 16);
    root.add(body);
    cabins.push(piece(body, new Vector3(0, 0, 150)));
    const windows = solid(box(52, 35, 11), m.glass, x, y, z + 19);
    windows.castShadow = false;
    root.add(windows);
    cabins.push(piece(windows, new Vector3(0, 0, 150)));
  };
  // One real office if it loaded, or the cabins drawn here if it didn't.
  const office = props?.make('site-office', 130);
  if (office) {
    office.position.set(-120, 92, 2);
    root.add(office);
    cabins.push(piece(office, new Vector3(0, 0, 150)));
  } else {
    addCabin(-120, 92, 2, m.cabin);
    addCabin(-120, 92, 34, m.white);
    addCabin(20, 104, 2, m.cabin);
  }
  inSequence(cabins, 0.4);

  addCrew(m, root, facts, [[-10, -60], [40, -86], [120, 10]]);

  return {
    root,
    height: 110,
    update({ work }) {
      placePieces(posts, within(work, 0, 0.75));
      placePieces(cabins, within(work, 0.35, 1));
    },
  };
}

/**
 * A whole model as a single mesh in one material, for a form that does not move: one draw call in place of hundreds.
 * Only what is showing goes in, instanced parts are written out, and mirrored parts keep their faces outward.
 */
export function bakeInto(root: Object3D, material: Material): Mesh {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const parts: BufferGeometry[] = [];
  const instance = new Matrix4();
  const place = new Matrix4();
  const add = (source: BufferGeometry, matrix: Matrix4): void => {
    const piece = source.index ? source.toNonIndexed() : source.clone();
    for (const name of Object.keys(piece.attributes)) if (name !== 'position' && name !== 'normal') piece.deleteAttribute(name);
    if (!piece.getAttribute('normal')) piece.computeVertexNormals();
    piece.applyMatrix4(matrix);
    if (matrix.determinant() < 0) {
      for (const name of ['position', 'normal']) {
        const data = piece.getAttribute(name).array as Float32Array;
        for (let at = 0; at + 9 <= data.length; at += 9) {
          for (let axis = 0; axis < 3; axis++) {
            const kept = data[at + 3 + axis]!;
            data[at + 3 + axis] = data[at + 6 + axis]!;
            data[at + 6 + axis] = kept;
          }
        }
      }
    }
    parts.push(piece);
  };
  root.traverseVisible((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    place.multiplyMatrices(toRoot, mesh.matrixWorld);
    const many = child as InstancedMesh;
    if (many.isInstancedMesh) {
      for (let index = 0; index < many.count; index++) {
        many.getMatrixAt(index, instance);
        add(mesh.geometry, new Matrix4().multiplyMatrices(place, instance));
      }
    } else {
      add(mesh.geometry, place);
    }
  });
  const merged = parts.length > 0 ? mergeGeometries(parts) : new BufferGeometry();
  for (const part of parts) part.dispose();
  const baked = new Mesh(merged, material);
  baked.castShadow = true;
  return baked;
}

export function buildKit(m: Materials, facts: TaskFacts, props: PropKit | null = null): Kit {
  switch (facts.kit) {
    case 'steel':
      return steelKit(m, facts);
    case 'concrete':
      return concreteKit(m, facts);
    case 'earth':
      return earthKit(m, facts, props);
    case 'envelope':
      return envelopeKit(m, facts);
    case 'site':
      return siteKit(m, facts, props);
    default:
      return interiorKit(m, facts);
  }
}
