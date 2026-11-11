/**
 * What stands in a room besides the work: the materials waiting to go in, and at most one piece of gear. Nothing else
 * competes with the work, its machine and its calendar. Materials arrive a few days ahead and run down as the work uses
 * them, and a finished job is swept clean. Everything here is scenery chosen from the kind of work; the facts of the
 * plan stay in the plan.
 */
import { ConeGeometry, Group, type Material, MeshStandardMaterial, type Object3D, Vector3 } from 'three';
import type { Progress, TaskFacts } from './facts';
import { box, lerp, type Materials, roundBox, solid, strut, upright } from './parts';
import type { PropKit } from './props';
import type { Spot } from './room-jobs';

export interface RoomSet {
  group: Group;
  /** Where what the work uses is piled, for those who carry it. */
  stock: readonly Spot[];
  update(progress: Progress, soon: boolean, dt: number): void;
}

/** A pile that runs down layer by layer as it is used. */
interface Stock {
  layers: Object3D[];
}

const random = (seed: number): (() => number) => {
  let value = Math.abs(seed * 9301 + 49297) % 233280;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
};

const place = <T extends Object3D>(object: T, x: number, y: number, turn = 0): T => {
  object.position.set(x, y, 0);
  object.rotation.z = turn;
  return object;
};

export function dressRoom(m: Materials, facts: TaskFacts, w: number, d: number, seed: number, props: PropKit | null = null): RoomSet {
  const group = new Group();
  const stock: Stock[] = [];
  const stuff = new Group(); // What arrives with the crew and leaves with it.
  const mess = new Group(); // What the job leaves lying around.
  const stockGroup = new Group();
  group.add(stockGroup, stuff, mess);
  const roll = random(seed);

  const bagPaper = new MeshStandardMaterial({ color: '#cfc7b4', roughness: 0.95 });
  const pallet = (): Group => {
    const item = new Group();
    for (const y of [-6, 0, 6]) item.add(solid(box(18, 1.4, 1), m.timber, 0, y, 0.5));
    for (const x of [-7, 0, 7]) item.add(solid(box(1.6, 16, 1.4), m.timber, x, 0, 1.7));
    return item;
  };

  const addStock = (item: Group, layers: Object3D[]): Group => {
    stock.push({ layers });
    stockGroup.add(item);
    return item;
  };

  /** The same model several times over, each one a layer of the pile: the work takes them one by one. */
  const pileOf = (make: () => Group | null, count: number, across: number, along: number): Group | null => {
    const first = make();
    if (!first) return null;
    const item = new Group();
    const layers: Object3D[] = [];
    for (let index = 0; index < count; index++) {
      const one = index === 0 ? first : make()!;
      one.position.set((index % 2) * across - across / 2 + (roll() - 0.5) * 2, Math.floor(index / 2) * along - along / 2 + (roll() - 0.5) * 2, 0);
      one.rotation.z = (roll() - 0.5) * 0.3;
      item.add(one);
      layers.push(one);
    }
    return addStock(item, layers);
  };

  /** Cement bags on a pallet. */
  const bags = (layersHigh: number): Group => {
    const real = pileOf(() => props?.make('cement-bags', 34) ?? null, 3, 32, 26);
    if (real) return real;
    const item = pallet();
    const layers: Object3D[] = [];
    for (let layer = 0; layer < layersHigh; layer++) {
      const row = new Group();
      for (const [x, y] of [[-3.8, -3.4], [3.8, -3.4], [-3.8, 3.4], [3.8, 3.4]] as const) row.add(solid(roundBox(7.2, 6.2, 2.2, 0.9), bagPaper, x + (roll() - 0.5) * 0.6, y + (roll() - 0.5) * 0.6, 3.6 + layer * 2.3));
      item.add(row);
      layers.push(row);
    }
    return addStock(item, layers);
  };

  /** Flat sheets: drywall, deck, wall panels. */
  const sheets = (material: Material, across: number, along: number, layersHigh: number): Group => {
    const real = material === m.drywall ? pileOf(() => props?.make('drywall', 46) ?? null, 2, 48, 0) : null;
    if (real) return real;
    const item = new Group();
    item.add(solid(box(across * 0.8, 2, 1.6), m.timber, 0, along * 0.32, 0.8), solid(box(across * 0.8, 2, 1.6), m.timber, 0, -along * 0.32, 0.8));
    const layers: Object3D[] = [];
    for (let layer = 0; layer < layersHigh; layer++) {
      const sheet = solid(box(across, along, 1.5), material, (roll() - 0.5) * 1.4, (roll() - 0.5) * 1.4, 2.4 + layer * 1.6);
      item.add(sheet);
      layers.push(sheet);
    }
    return addStock(item, layers);
  };

  /** Lengths on bearers: steel beams, lumber. */
  const lengths = (make: (x: number, z: number) => Object3D, across: number, along: number, rows: number, perRow: number, high: number): Group => {
    const item = new Group();
    item.add(solid(box(across + 4, 2, 1.8), m.timber, 0, along * 0.32, 0.9), solid(box(across + 4, 2, 1.8), m.timber, 0, -along * 0.32, 0.9));
    const layers: Object3D[] = [];
    for (let row = 0; row < rows; row++) {
      const layer = new Group();
      for (let index = 0; index < perRow; index++) layer.add(make(((index - (perRow - 1) / 2) * across) / Math.max(1, perRow - 1 || 1), 2.4 + row * high));
      item.add(layer);
      layers.push(layer);
    }
    return addStock(item, layers);
  };

  const rebar = (length: number): Group =>
    lengths(
      (x, z) => {
        const row = new Group();
        for (const nudge of [-0.8, 0, 0.8]) row.add(solid(strut(new Vector3(x + nudge, -length / 2, z), new Vector3(x + nudge, length / 2, z), 0.32, 5), m.rebar));
        return row;
      },
      14,
      length,
      3,
      4,
      1.1,
    );

  /** Pipes and duct on a rack. */
  const pipes = (): Group => {
    const real = pileOf(() => props?.make('tubes', 46) ?? null, 3, 22, 30);
    if (real) return real;
    const item = new Group();
    for (const y of [-14, 14]) {
      item.add(solid(box(1.2, 1.2, 12), m.machineDark, -10, y, 6), solid(box(1.2, 1.2, 12), m.machineDark, 10, y, 6), solid(box(21, 1.2, 1.2), m.machineDark, 0, y, 11.6));
    }
    const layers: Object3D[] = [];
    const kinds = [m.pipe, m.copper, m.duct, m.pipe, m.duct, m.copper];
    kinds.forEach((material, index) => {
      const x = -7.5 + (index % 3) * 7.5;
      const z = 13 + Math.floor(index / 3) * 3.2;
      const pipe = solid(strut(new Vector3(x, -22, z), new Vector3(x, 22, z), material === m.duct ? 1.6 : 1, 8), material);
      item.add(pipe);
      layers.push(pipe);
    });
    return addStock(item, layers);
  };

  /** Fence panels waiting to go up, stood on edge. */
  const panels = (): Group => {
    const item = new Group();
    item.add(solid(box(2, 24, 1.6), m.timber, -10, 0, 0.8), solid(box(2, 24, 1.6), m.timber, 10, 0, 0.8));
    const layers: Object3D[] = [];
    for (let index = 0; index < 7; index++) {
      const panel = solid(box(30, 0.5, 15), m.stud, 0, -9 + index * 3, 9);
      item.add(panel);
      layers.push(panel);
    }
    return addStock(item, layers);
  };

  const heap = (radius: number, height: number, material: Material): Object3D => {
    const real = props?.make('gravel', radius * 2.4);
    if (real) return real;
    const mound = solid(new ConeGeometry(radius, height, 9, 1).rotateX(Math.PI / 2), material, 0, 0, height / 2);
    mound.scale.y = 0.72;
    return mound;
  };

  // Where things stand: around the edges of the room, leaving its middle to the work.
  const [X, Y] = [w / 2, d / 2];
  const backLeft = [-X + 34, Y - 24] as const;
  const backMiddle = [-X * 0.05, Y - 20] as const;
  const backRight = [X - 40, Y - 24] as const;
  const sideRight = [X - 22, 6] as const;
  const frontRight = [X - 34, -Y + 24] as const;

  const stockSpots: Spot[] = [];
  const stand = (parent: Group, item: Object3D | null, at: readonly [number, number], turn = 0): void => {
    if (!item) return;
    parent.add(place(item, at[0], at[1], turn));
    // Those who carry it come to the side of the pile that faces the room.
    if (parent === stockGroup) stockSpots.push({ x: at[0] * 0.86, y: at[1] * 0.8 });
  };

  switch (facts.kit) {
    case 'site':
      stand(stockGroup, panels(), frontRight, 0.2);
      break;
    case 'earth':
      stand(mess, heap(36, 26, m.soil), backRight);
      break;
    case 'concrete':
      stand(stockGroup, rebar(52), backLeft, Math.PI / 2);
      stand(stockGroup, bags(5), sideRight);
      stand(stuff, props?.make('mixer', 26) ?? null, [backMiddle[0] + 16, backMiddle[1] - 8], 0.5);
      break;
    case 'steel':
      // The steel waiting on the ground is part of its model.
      break;
    case 'envelope':
      stand(stockGroup, sheets(m.deck, 44, 18, 7), backLeft);
      break;
    default:
      stand(stockGroup, sheets(m.drywall, 40, 20, 8), backLeft);
      stand(stockGroup, pipes(), sideRight);
      break;
  }

  const u = { stock: 0, stuff: 0, mess: 0 };
  // Heaps and piles grow out of the floor from where they stand, so each item scales itself.
  const grow = (parent: Group, value: number): void => {
    parent.visible = value > 0.01;
    for (const child of parent.children) child.scale.setScalar(Math.max(0.001, value));
  };

  return {
    group,
    stock: stockSpots,
    update(progress, soon, dt) {
      const ahead = progress.state === 'ahead';
      const done = progress.state === 'done';
      const ease = 1 - Math.exp(-6 * dt);
      u.stock = lerp(u.stock, done || (ahead && !soon) ? 0 : 1, ease);
      u.stuff = lerp(u.stuff, ahead && !soon ? 0 : facts.kit === 'site' ? 1 : done ? 0 : 1, ease);
      u.mess = lerp(u.mess, ahead || done ? 0 : Math.min(1, 0.25 + progress.built * 1.1), ease);
      grow(stockGroup, u.stock);
      grow(stuff, u.stuff);
      grow(mess, u.mess);
      // Each pile runs down as the work uses it, leaving a little until the last day.
      const used = ahead ? 0 : progress.built;
      for (const { layers } of stock) {
        const left = done ? 0 : Math.max(1, Math.ceil(layers.length * (1 - used * 0.92)));
        layers.forEach((layer, index) => {
          layer.visible = index < left;
        });
      }
    },
  };
}
