/**
 * The building of a plan, as it stands on any date: every row of the plan is a piece of it (building-plan.ts), and a
 * piece is built as its row's working days pass, part by part, each part settling into place, so scrubbing the date
 * back and forth always shows the same thing. The foundations below the ground, then a layer per story, then the
 * roof; the layers can be pulled apart, so every floor can be looked into at once, and one floor can be lifted clear
 * of those above it.
 *
 * Pieces are drawn as a model maker would: a dark steel frame, pale concrete that is dark while it is wet, glass on
 * every side that opens at the front and the left when someone looks inside, and the fit-out in true colors. A piece
 * can be shown in its own colors, tinted (by firm, by money), or faded to a pale ghost when someone isolates other
 * work. The steel and the glass are one row each: they go up story by story.
 *
 * Units are those of the other scale models: a worker is about 22 tall, z is up, the footprint is 300 by 200.
 */
import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  type Raycaster,
  RepeatWrapping,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { builtBy, type BuildingPlan, FOUNDATIONS, machineOn, type Part, type PartKind, type PlanTask, roofOf } from './building-plan';
import { createSite, CRANE_AT, DIG, FOOTPRINT, LAYDOWN, MIXER_AT, PUMP_AT, type SiteModel } from './building-site';
import { machineMaterials, mergeShapes as mergeGeometries, mixerTruck, pumpTruck, scissorLift, towerCrane, type TowerCrane } from './machines';
import { iSection } from './parts';
import type { Worker, WorkerKit } from './people';
import type { PropKit } from './props';

// -----------------------------------------------------------------------------------------
// Dimensions
// -----------------------------------------------------------------------------------------

const W = FOOTPRINT.x1 - FOOTPRINT.x0;
const D = FOOTPRINT.y1 - FOOTPRINT.y0;
const X0 = FOOTPRINT.x0;
const X1 = FOOTPRINT.x1;
const Y0 = FOOTPRINT.y0;
const Y1 = FOOTPRINT.y1;
/** Top of the slab on grade. */
export const GROUND = 5;
/** Floor to floor. */
export const STORY = 60;
/** From the top of a floor down to the underside of its beams: concrete, metal deck, steel. */
const PLATE = 10;
const TOPPING = 3.6;
const RIBS = 1.6;
/** The ceiling grid, above its floor. */
const CEIL = 40;
const COLUMNS_X = [-147, -49, 49, 147];
const COLUMNS_Y = [-97, 0, 97];
const CORE = { x0: 104, x1: 147, y0: 50, y1: 97 };
const inCore = (x: number, y: number, margin = 2) => x > CORE.x0 - margin && y > CORE.y0 - margin;
/** Partitions on every office floor (x1, y1, x2, y2): offices along the back, a meeting room at the front right. */
const WALLS: readonly (readonly [number, number, number, number])[] = [
  [-148, 36, 102, 36],
  [-86, 36, -86, 96],
  [-24, 36, -24, 96],
  [38, 36, 38, 96],
  [60, -34, 146, -34],
  [60, -34, 60, 36],
];
const ACCENT_WALL = 4;
const CELL_W = 30;
const CELL_D = 15;
const GRID_ROWS = 13;
const GRID_Y0 = -97.5;
const isLightCell = (ix: number, iy: number) => ix % 2 === 1 && iy % 3 === 1;

/** Top of a story's floor: the ground floor is story 0. */
export const floorTop = (story: number) => GROUND + story * STORY;
/** A layer's story: layer 1 is the ground floor. */
const storyOf = (layer: number) => layer - 1;

// -----------------------------------------------------------------------------------------
// The model's interface
// -----------------------------------------------------------------------------------------

export interface PaintRule {
  /** Pieces this says false for are faded to a ghost. */
  keep?: ((taskId: number, layer: number) => boolean) | null;
  /** A color for a task's pieces instead of their own. */
  tint?: ((taskId: number) => string | null) | null;
  /** The piece under the pointer, outlined in light. */
  hover?: number | null;
  /** Pieces this says true for aren't drawn at all: the building assembles as the chart's bars land in it. */
  hidden?: ((taskId: number) => boolean) | null;
}

export interface BuildingModel {
  root: Group;
  site: SiteModel;
  plan: BuildingPlan;
  /** Where a layer's floor is when the building is together, and how tall it is. */
  layerSpan(index: number): { z: number; height: number };
  setDate(date: number): void;
  /** How far each layer is lifted off the one below, by index. */
  setOffsets(offsets: readonly number[]): void;
  offsetOf(index: number): number;
  /** The glass at the front and the left, from there (0) to gone (1), to look inside. */
  setCutaway(amount: number): void;
  setPaint(rule: PaintRule): void;
  /**
   * The stories not built yet stand as faint outlines, so the building it is going to be is always there; the one
   * being looked at (`index`) is drawn in the accent color. Null: none stands out.
   */
  setOutline(index: number | null): void;
  /** What the camera takes in to show the whole site: the building as it will stand, and the crane while it is up (unless left out). */
  siteBounds(target: Box3, withCrane?: boolean): Box3;
  /** The tower crane, mast to jib, while it is up; null when it isn't. */
  craneBounds(target: Box3): Box3 | null;
  /** Where the crane's hook is now, in the scene, while the crane is up; null when it isn't. */
  craneHook(target: Vector3): Vector3 | null;
  /** The foot of the crane's mast, in the scene. */
  craneBase(target: Vector3): Vector3;
  /** The crane's jib: how high it is over the mast's foot, and how far it reaches. */
  craneJib(): { height: number; reach: number } | null;
  /**
   * Someone riding up on the crane: while it has nothing to lift, its jib swings round (in about a second) to hang the
   * hook this high over this point of the lot, and stays there; a working crane goes on with its lifts. Null lets it
   * drift with the wind again.
   */
  holdCrane(over: { x: number; y: number; hookZ: number } | null): void;
  /** How high what is built stands on the date on show, over the lot (0 before anything is up). */
  builtTop(): number;
  /** The layers with light fixtures in them, lowest first. */
  lightLayers(): number[];
  /** Each floor's lights, 0 to 1, by layer, for the film's dusk shot; null gives them back to their test dates. */
  setFloorLights(on: ((layer: number) => number) | null): void;
  /** The task under a ray, and the layer of the piece it hit. */
  pick(ray: Raycaster): { taskId: number; layer: number } | null;
  /** What a task's pieces take up, where they are now; null when it has none. */
  boundsOf(taskId: number, target: Box3): Box3 | null;
  /** The middle of a layer, where it is now. */
  layerCenter(index: number, target: Vector3): Vector3;
  /** Machines and people: moves of their own, whatever the date. */
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface BuildingOptions {
  workers?: WorkerKit | null;
  props?: PropKit | null;
  /** The rings that pulse round a machine on rent with nothing to do; false leaves them out. Default true. */
  idleRings?: boolean;
}

// -----------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** How far the wind turns a held jib, in radians, at a time in seconds: the camera riding it turns with it. */
export const jibSway = (time: number): number => Math.sin(time * 0.55) * 0.01;
const within = (value: number, from: number, to: number) => (to <= from ? (value >= to ? 1 : 0) : clamp01((value - from) / (to - from)));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function solid(geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0, shadows = true): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  return mesh;
}

const box = (w: number, d: number, h: number) => new BoxGeometry(w, d, h);
const rounded = (w: number, d: number, h: number, r: number) => new RoundedBoxGeometry(w, d, h, 2, Math.min(r, Math.min(w, d, h) / 2 - 0.01));

const UP = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);
function rod(a: Vector3, b: Vector3, radius: number, sides = 6): BufferGeometry {
  const geometry = new CylinderGeometry(radius, radius, a.distanceTo(b), sides);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(Y_AXIS, new Vector3().subVectors(b, a).normalize()));
  const middle = new Vector3().addVectors(a, b).multiplyScalar(0.5);
  geometry.translate(middle.x, middle.y, middle.z);
  return geometry;
}

/** A wide-flange member of this depth and length, centered, its length along x and its depth along z. */
function beamGeometry(depth: number, length: number): BufferGeometry {
  const geometry = iSection(depth);
  geometry.scale(1, 1, length);
  geometry.rotateY(Math.PI / 2);
  geometry.rotateX(Math.PI / 2);
  geometry.center();
  return geometry;
}

/** A wide-flange column of this size and height, standing on its base. */
function columnGeometry(size: number, height: number): BufferGeometry {
  const geometry = iSection(size);
  geometry.scale(1, 1, height);
  geometry.center();
  geometry.translate(0, 0, height / 2);
  return geometry;
}

interface Place {
  x: number;
  y: number;
  z: number;
  /** About z, in radians. */
  turn?: number;
  /** When it starts to arrive, as a share of its piece's work. */
  at?: number;
  scale?: Vector3;
}

const quarter = Math.PI / 2;
const unit = new Vector3(1, 1, 1);

/** When each of `count` parts starts to arrive, so the last has `settle` of the work left to land. */
const startsFor = (count: number, settle: number) => Array.from({ length: count }, (_, index) => (count <= 1 ? 0 : (index / count) * (1 - settle)));

/** Separate meshes that land one after another, each from `from` away. */
function landing(meshes: readonly Object3D[], from: Vector3, settle = 0.3, starts?: readonly number[]): (progress: number, force?: boolean) => void {
  const homes = meshes.map((mesh) => mesh.position.clone());
  const at = starts ?? startsFor(meshes.length, settle);
  for (const mesh of meshes) mesh.visible = false;
  let last = -1;
  // `force` lands them again although the progress is the same: something else may have taken one away since.
  return (progress, force = false) => {
    if (progress === last && !force) return;
    last = progress;
    meshes.forEach((mesh, index) => {
      const start = at[index]!;
      mesh.visible = progress > start;
      if (!mesh.visible) return;
      const landed = easeOut(within(progress, start, start + settle));
      mesh.position.copy(homes[index]!).addScaledVector(from, 1 - landed);
    });
  };
}

/** Many of one part as one instanced mesh, landing in order (or each at its own `at`). */
function instances(geometry: BufferGeometry, material: Material, places: readonly Place[], from: Vector3, settle = 0.3, colors?: readonly Color[]): { mesh: InstancedMesh; set(progress: number): void } {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, places.length));
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const fallback = startsFor(places.length, settle);
  // In the order they arrive, so the ones that show are always the first `count`.
  const order = places.map((place, index) => ({ place, start: place.at ?? fallback[index]!, index })).sort((a, b) => a.start - b.start);
  if (colors) order.forEach((entry, slot) => mesh.setColorAt(slot, colors[entry.index]!));
  const matrix = new Matrix4();
  const at = new Vector3();
  const turn = new Quaternion();
  const landed = new Float32Array(order.length).fill(-1);
  let last = -1;
  return {
    mesh,
    set(progress) {
      if (progress === last) return;
      last = progress;
      let count = 0;
      let moved = false;
      for (let slot = 0; slot < order.length; slot++) {
        const { place, start } = order[slot]!;
        if (progress <= start) break;
        count = slot + 1;
        const t = easeOut(within(progress, start, start + settle));
        if (t === landed[slot]) continue;
        landed[slot] = t;
        at.set(place.x, place.y, place.z).addScaledVector(from, 1 - t);
        turn.setFromAxisAngle(UP, place.turn ?? 0);
        mesh.setMatrixAt(slot, matrix.compose(at, turn, place.scale ?? unit));
        moved = true;
      }
      if (moved || mesh.count !== count) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

/** Points every `step` along a wall. */
function along(wall: readonly [number, number, number, number], step: number): { x: number; y: number; turned: boolean; length: number }[] {
  const [x1, y1, x2, y2] = wall;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const turned = Math.abs(y2 - y1) > Math.abs(x2 - x1);
  const count = Math.max(1, Math.round(length / step));
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 0.5) / count;
    return { x: lerp(x1, x2, t), y: lerp(y1, y2, t), turned, length: length / count };
  });
}

function stripes(light: string, dark: string, count: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 8;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = light;
  paint.fillRect(0, 0, 64, 8);
  paint.fillStyle = dark;
  for (let index = 0; index < 4; index++) paint.fillRect(index * 16 + 9, 0, 5, 8);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(count, 1);
  texture.anisotropy = 8;
  return texture;
}

function speckle(base: string, spread: number, repeat: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = base;
  paint.fillRect(0, 0, 128, 128);
  const image = paint.getImageData(0, 0, 128, 128);
  let seed = 11;
  for (let index = 0; index < image.data.length; index += 4) {
    seed = (seed * 16807) % 2147483647;
    const grain = (seed / 2147483647 - 0.5) * spread;
    for (let channel = 0; channel < 3; channel++) image.data[index + channel] = Math.max(0, Math.min(255, image.data[index + channel]! + grain));
  }
  paint.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  return texture;
}

// -----------------------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------------------

function buildingMaterials() {
  const standard = (color: string, roughness: number, metalness = 0, extra: Partial<MeshStandardMaterial> = {}) => Object.assign(new MeshStandardMaterial({ color, roughness, metalness }), extra);
  return {
    steel: standard('#3b434c', 0.48, 0.55),
    steelLight: standard('#59626b', 0.5, 0.5),
    deck: new MeshStandardMaterial({ map: stripes('#b7bcc0', '#959ba1', 30), roughness: 0.42, metalness: 0.65 }),
    concrete: standard('#cfccc5', 0.92),
    concreteDark: standard('#bdb9b1', 0.95),
    gravel: new MeshStandardMaterial({ map: speckle('#b4aea2', 70, 10), roughness: 1 }),
    barrier: standard('#2f3a44', 0.35, 0.05, { transparent: true, opacity: 0.88 }),
    rebar: standard('#8f5534', 0.62, 0.45),
    plywood: new MeshStandardMaterial({ map: speckle('#d4ab74', 22, 3), roughness: 0.78 }),
    shore: standard('#e0a234', 0.5, 0.4),
    frame: standard('#3d454d', 0.38, 0.65),
    spandrel: standard('#4b555e', 0.32, 0.45),
    glassNear: new MeshPhysicalMaterial({ color: '#b4cfdc', roughness: 0.04, metalness: 0.25, transparent: true, opacity: 0.38, clearcoat: 1, envMapIntensity: 1.8, depthWrite: false }),
    glassFar: new MeshPhysicalMaterial({ color: '#a7c3d2', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.5, clearcoat: 1, envMapIntensity: 1.8, depthWrite: false }),
    frameNear: standard('#3d454d', 0.38, 0.65, { transparent: true, opacity: 1 }),
    spandrelNear: standard('#4b555e', 0.32, 0.45, { transparent: true, opacity: 1 }),
    membrane: standard('#f1f0ec', 0.8),
    insulation: standard('#e4d9b4', 0.9),
    cap: standard('#8d949a', 0.45, 0.6),
    unit: standard('#c9cdd0', 0.5, 0.35),
    louver: standard('#4d555c', 0.55, 0.4),
    stud: standard('#a9b0b6', 0.4, 0.7),
    duct: standard('#c3c9ce', 0.36, 0.78),
    conduit: standard('#8e979e', 0.45, 0.6),
    pipe: standard('#58758f', 0.45, 0.25),
    ceiling: standard('#f5f5f2', 0.6),
    tile: standard('#ecebe6', 0.92),
    chalk: new MeshBasicMaterial({ color: '#4f7fbf', toneMapped: false }),
    crate: standard('#c8a77a', 0.82),
    stone: standard('#ffffff', 0.55),
    oak: standard('#b2875c', 0.62),
    desk: standard('#f3f2ee', 0.42),
    planter: standard('#3e4449', 0.5, 0.2),
    leaf: standard('#7f9a72', 0.8, 0, { flatShading: true }),
    glow: new MeshStandardMaterial({ color: '#f6efe0', emissive: new Color('#ffe2b0'), emissiveIntensity: 0, roughness: 0.4 }),
    signDark: standard('#2b3036', 0.4, 0.3),
    pier: standard('#c6c2ba', 0.93),
  };
}

type Look = ReturnType<typeof buildingMaterials>;

// -----------------------------------------------------------------------------------------
// Pieces
// -----------------------------------------------------------------------------------------

interface Piece {
  task: PlanTask;
  kind: PartKind;
  layer: number;
  /** What a material change applies to. */
  objects: (Mesh | InstancedMesh)[];
  /** The share of its row's work it is built in. */
  range: readonly [number, number];
  set(progress: number, time: number): void;
  /** Where it is, with the building together, for labels and the camera. */
  box: Box3;
  /** Glass: faded with the cutaway rather than painted. */
  glassy?: boolean;
}

// -----------------------------------------------------------------------------------------
// The building
// -----------------------------------------------------------------------------------------

export function createBuilding(plan: BuildingPlan, options: BuildingOptions = {}): BuildingModel {
  const root = new Group();
  const look = buildingMaterials();
  const owned: Material[] = Object.values(look);
  const site = createSite();
  root.add(site.root);
  const stories = plan.stories;
  const roof = roofOf(plan);

  const layerGroups = plan.layers.map((layer) => {
    const group = new Group();
    group.name = layer.name;
    root.add(group);
    return group;
  });
  const offsets = plan.layers.map(() => 0);
  const pieces: Piece[] = [];
  const byTask = new Map<number, Piece[]>();
  /** The date on show: pieces that depend on another row (forms struck after the cure) read it. */
  let dateNow = plan.span[0];
  const pours: { part: Part; layer: number; front(progress: number, target: Vector3): Vector3 }[] = [];
  const cures: { part: Part; layer: number }[] = [];
  const own = <T extends Material>(material: T): T => {
    owned.push(material);
    return material;
  };

  const add = (part: Part, layer: number, objects: Object3D[], set: (progress: number, time: number) => void, range: readonly [number, number] = [0, 1], glassy = false) => {
    const group = layerGroups[layer]!;
    const paintable: (Mesh | InstancedMesh)[] = [];
    const box3 = new Box3();
    for (const object of objects) {
      group.add(object);
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.userData.base = mesh.material;
        mesh.userData.taskId = part.task.id;
        mesh.userData.layer = layer;
        paintable.push(mesh);
      });
    }
    // The box is worked out from where the parts end up: at their homes, all shown.
    const piece: Piece = { task: part.task, kind: part.kind, layer, objects: paintable, range, set, box: box3, glassy };
    pieces.push(piece);
    byTask.set(part.task.id, [...(byTask.get(part.task.id) ?? []), piece]);
    return piece;
  };

  /** Measures a piece with everything in it built. */
  const measure = (piece: Piece) => {
    piece.set(1, 0);
    piece.box.makeEmpty();
    for (const object of piece.objects) {
      object.updateWorldMatrix(true, false);
      if ((object as InstancedMesh).isInstancedMesh) {
        const instanced = object as InstancedMesh;
        instanced.computeBoundingBox();
        instanced.computeBoundingSphere();
        if (instanced.boundingBox) piece.box.union(instanced.boundingBox.clone().applyMatrix4(instanced.matrixWorld));
      } else {
        object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox) piece.box.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      }
    }
    piece.set(0, 0);
  };

  const partsOf = (kind: PartKind, layer?: number) => plan.parts.filter((part) => part.kind === kind && (layer === undefined || part.layer === layer));
  const first = (kind: PartKind, layer?: number) => partsOf(kind, layer)[0] ?? null;
  /** A shell the plan doesn't build (a fit-out of an existing building) stands from the start: no row is behind it. */
  const standing = (kind: PartKind): Part => ({
    kind,
    layer: -1,
    target: null,
    task: { id: -1, name: 'Existing building', path: [], pathIds: [], wbs: '', start: 0, end: 0, workDays: [], color: '#888888', crews: [], machine: null, percent: 100, milestone: false },
  });

  // ---------------------------------------------------------------------------------------
  // Foundations: footings under each column and a strip under the core, formed, barred, poured, stripped
  // ---------------------------------------------------------------------------------------

  const footingSpots = COLUMNS_Y.flatMap((y) => COLUMNS_X.filter((x) => !inCore(x, y, 8)).map((x) => ({ x, y, w: 26, d: 26 })));
  footingSpots.push({ x: (CORE.x0 + CORE.x1) / 2, y: (CORE.y0 + CORE.y1) / 2, w: CORE.x1 - CORE.x0 + 12, d: CORE.y1 - CORE.y0 + 12 });
  const padBottom = -DIG.depth;
  const padHeight = 7;
  const padTop = padBottom + padHeight;
  for (const part of plan.parts.filter((entry) => entry.target === 'footings' || entry.kind === 'excavate' || entry.kind === 'mobilize')) {
    if (part.kind === 'forms') {
      const boards = footingSpots.map((spot) => {
        const group = new Group();
        const t = 1.2;
        group.add(solid(box(spot.w + 2 * t, t, padHeight + 2), look.plywood, 0, -spot.d / 2 - t / 2, padHeight / 2 + 1));
        group.add(solid(box(spot.w + 2 * t, t, padHeight + 2), look.plywood, 0, spot.d / 2 + t / 2, padHeight / 2 + 1));
        group.add(solid(box(t, spot.d, padHeight + 2), look.plywood, -spot.w / 2 - t / 2, 0, padHeight / 2 + 1));
        group.add(solid(box(t, spot.d, padHeight + 2), look.plywood, spot.w / 2 + t / 2, 0, padHeight / 2 + 1));
        group.position.set(spot.x, spot.y, padBottom);
        return group;
      });
      const land = landing(boards, new Vector3(0, 0, 30), 0.25);
      // Struck once the footings are poured: the strip row takes them away.
      const strip = first('strip', FOUNDATIONS) ?? partsOf('strip').find((entry) => entry.target === 'footings') ?? null;
      const piece = add(part, FOUNDATIONS, boards, (progress) => {
        land(progress, true);
        if (!strip) return;
        const struck = strippedBy(strip);
        boards.forEach((board, index) => {
          if (struck > (index + 0.5) / boards.length) board.visible = false;
        });
      });
      measure(piece);
    } else if (part.kind === 'rebar') {
      const mats = footingSpots.map((spot) => {
        const bars: BufferGeometry[] = [];
        const step = 4;
        for (let x = -spot.w / 2 + 3; x <= spot.w / 2 - 3; x += step) bars.push(rod(new Vector3(x, -spot.d / 2 + 2, 2.4), new Vector3(x, spot.d / 2 - 2, 2.4), 0.45, 5));
        for (let y = -spot.d / 2 + 3; y <= spot.d / 2 - 3; y += step) bars.push(rod(new Vector3(-spot.w / 2 + 2, y, 3.2), new Vector3(spot.w / 2 - 2, y, 3.2), 0.45, 5));
        for (const [dx, dy] of [
          [-3, -3],
          [3, -3],
          [-3, 3],
          [3, 3],
        ] as const)
          bars.push(rod(new Vector3(dx, dy, 2), new Vector3(dx, dy, padHeight + DIG.depth - padHeight + 2), 0.5, 5));
        const mesh = solid(mergeGeometries(bars), look.rebar, spot.x, spot.y, padBottom);
        for (const geometry of bars) geometry.dispose();
        return mesh;
      });
      const piece = add(part, FOUNDATIONS, mats, ((land) => (progress: number) => land(progress))(landing(mats, new Vector3(0, 0, 24), 0.25)));
      measure(piece);
    } else if (part.kind === 'pour') {
      const pads = footingSpots.map((spot) => solid(box(spot.w, spot.d, padHeight), look.concrete, spot.x, spot.y, padBottom + padHeight / 2));
      const piers = footingSpots.slice(0, -1).map((spot) => solid(box(10, 10, -padTop), look.pier, spot.x, spot.y, padTop / 2));
      const all = [...pads, ...piers];
      const piece = add(part, FOUNDATIONS, all, (progress) => {
        pads.forEach((pad, index) => {
          const t = within(progress, (index / pads.length) * 0.8, (index / pads.length) * 0.8 + 0.2);
          pad.visible = t > 0;
          pad.scale.z = Math.max(0.001, t);
          pad.position.z = padBottom + (padHeight * t) / 2;
        });
        piers.forEach((pier, index) => {
          const t = within(progress, (index / piers.length) * 0.8 + 0.12, (index / piers.length) * 0.8 + 0.2);
          pier.visible = t > 0;
          pier.scale.z = Math.max(0.001, t);
          pier.position.z = padTop + (-padTop * t) / 2;
        });
      });
      measure(piece);
      pours.push({ part, layer: FOUNDATIONS, front: (progress, target) => {
        const index = Math.min(footingSpots.length - 1, Math.floor(progress * footingSpots.length));
        const spot = footingSpots[index]!;
        return target.set(spot.x, spot.y, padTop + 4);
      } });
    }
  }

  // ---------------------------------------------------------------------------------------
  // The slab on grade (the ground floor's own floor): stone and the barrier, mesh, the pour, the cure
  // ---------------------------------------------------------------------------------------

  const groundLayer = 1;
  const concreteFor = new Map<number, MeshPhysicalMaterial>();
  const wetColor = new Color('#73777a');
  const curedColor = new Color('#cdc9c1');
  const wetConcrete = () => own(new MeshPhysicalMaterial({ color: wetColor.clone(), roughness: 0.16, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 }));

  /** A concrete pour across a plate, from left to right, then its cure from wet to dry. */
  const plateConcrete = (layer: number, z0: number, thick: number) => {
    const material = wetConcrete();
    concreteFor.set(layer, material);
    const slab = solid(box(W + 4, D + 4, thick), material, X0 - 2 + (W + 4) / 2, 0, z0 + thick / 2);
    // The screed at the pour's front.
    const screed = solid(box(2, D + 4, 1.4), look.steelLight, 0, 0, z0 + thick + 0.8, false);
    return { slab, screed, material };
  };

  const slabParts = plan.parts.filter((part) => part.target === 'slab');
  for (const part of slabParts) {
    if (part.kind === 'base') {
      const strips = 6;
      const gravel = Array.from({ length: strips }, (_, index) => solid(box(W / strips + 0.2, D + 4, 1.4), look.gravel, X0 + (index + 0.5) * (W / strips), 0, 0.7, false));
      const sheets = Array.from({ length: strips }, (_, index) => solid(box(W / strips - 0.4, D + 2, 0.2), look.barrier, X0 + (index + 0.5) * (W / strips), 0, 1.55, false));
      const landGravel = landing(gravel, new Vector3(0, 0, 10), 0.3, startsFor(strips, 0.3).map((at) => at * 0.5));
      const landSheets = landing(sheets, new Vector3(-16, 0, 0), 0.3, startsFor(strips, 0.3).map((at) => 0.5 + at * 0.5));
      const pour = slabParts.find((entry) => entry.kind === 'pour') ?? null;
      const piece = add(part, groundLayer, [...gravel, ...sheets], (progress) => {
        landGravel(progress);
        landSheets(progress, true);
        // The barrier goes under the concrete as it is poured.
        if (pour && builtBy(pour.task, dateNow) >= 1) for (const sheet of sheets) sheet.visible = false;
      });
      measure(piece);
    } else if (part.kind === 'rebar') {
      piecesOfMesh(part, groundLayer, 1.6 + 1.4);
    } else if (part.kind === 'pour') {
      const { slab, screed, material } = plateConcrete(groundLayer, 1.5, GROUND - 1.5);
      const piece = add(part, groundLayer, [slab, screed], (progress) => {
        slab.visible = progress > 0;
        slab.scale.x = Math.max(0.001, progress);
        slab.position.x = X0 - 2 + ((W + 4) * progress) / 2;
        screed.visible = progress > 0 && progress < 1;
        screed.position.x = X0 - 2 + (W + 4) * progress;
      });
      void material;
      measure(piece);
      pours.push({ part, layer: groundLayer, front: (progress, target) => target.set(X0 + W * progress, -30 + 40 * Math.sin(progress * 37), GROUND) });
    } else if (part.kind === 'cure') {
      cures.push({ part, layer: groundLayer });
    }
  }

  /** A mesh of bars over a plate, row after row. */
  function piecesOfMesh(part: Part, layer: number, z: number) {
    const step = 12;
    const xs: Place[] = [];
    for (let y = Y0 + 6; y <= Y1 - 6; y += step) xs.push({ x: 0, y, z });
    const ys: Place[] = [];
    for (let x = X0 + 6; x <= X1 - 6; x += step) ys.push({ x, y: 0, z: z + 0.9 });
    const alongX = instances(box(W - 4, 0.9, 0.9), look.rebar, xs, new Vector3(0, 0, 12), 0.25);
    const alongY = instances(box(0.9, D - 4, 0.9), look.rebar, ys, new Vector3(0, 0, 12), 0.25);
    alongX.mesh.castShadow = false;
    alongY.mesh.castShadow = false;
    const piece = add(part, layer, [alongX.mesh, alongY.mesh], (progress) => {
      alongX.set(within(progress, 0, 0.55));
      alongY.set(within(progress, 0.45, 1));
    });
    measure(piece);
    return piece;
  }

  // ---------------------------------------------------------------------------------------
  // The steel and the metal deck: story by story, columns and core, then the floor plate above
  // ---------------------------------------------------------------------------------------

  const steel = first('steel') ?? standing('steel');
  const columnPlaces = COLUMNS_Y.flatMap((y) => COLUMNS_X.filter((x) => !inCore(x, y)).map((x) => ({ x, y })));
  if (steel) {
    const segments = stories * 2;
    for (let story = 0; story < stories; story++) {
      const layer = story + 1;
      const base = floorTop(story);
      const height = STORY - PLATE + TOPPING + RIBS;
      // Columns and the core's walls for this story.
      const columns = instances(columnGeometry(7, height), look.steel, columnPlaces.map((spot) => ({ x: spot.x, y: spot.y, z: base })), new Vector3(0, 0, 40), 0.35);
      const plates = story === 0 ? instances(box(14, 14, 1.2), look.steelLight, columnPlaces.map((spot) => ({ x: spot.x, y: spot.y, z: base + 0.6 })), new Vector3(0, 0, 20), 0.35) : null;
      const core: Mesh[] = [];
      const coreH = STORY;
      const t = 3;
      core.push(solid(box(CORE.x1 - CORE.x0, t, coreH), look.concreteDark, (CORE.x0 + CORE.x1) / 2, CORE.y0 + t / 2, base + coreH / 2));
      core.push(solid(box(t, CORE.y1 - CORE.y0, coreH), look.concreteDark, CORE.x1 - t / 2, (CORE.y0 + CORE.y1) / 2, base + coreH / 2));
      core.push(solid(box(CORE.x1 - CORE.x0, t, coreH), look.concreteDark, (CORE.x0 + CORE.x1) / 2, CORE.y1 - t / 2, base + coreH / 2));
      // The core's wall toward the floor, with a door in it.
      core.push(solid(box(t, 16, coreH), look.concreteDark, CORE.x0 + t / 2, CORE.y0 + 8, base + coreH / 2));
      core.push(solid(box(t, CORE.y1 - CORE.y0 - 30, coreH), look.concreteDark, CORE.x0 + t / 2, CORE.y1 - (CORE.y1 - CORE.y0 - 30) / 2, base + coreH / 2));
      core.push(solid(box(t, 14, coreH - 32), look.concreteDark, CORE.x0 + t / 2, CORE.y0 + 23, base + 32 + (coreH - 32) / 2));
      const coreLand = landing(core, new Vector3(0, 0, 36), 0.4);
      // Braces in two bays on the back and the left: a little of how the frame stands up to the wind.
      const braceBays: [Vector3, Vector3, Vector3, Vector3][] = [
        [new Vector3(-147, 97, base), new Vector3(-49, 97, base), new Vector3(-147, 97, base + STORY - PLATE), new Vector3(-49, 97, base + STORY - PLATE)],
        [new Vector3(-147, -97, base), new Vector3(-147, 0, base), new Vector3(-147, -97, base + STORY - PLATE), new Vector3(-147, 0, base + STORY - PLATE)],
      ];
      const braces = braceBays.map(([a, b, c, d]) => solid(mergeGeometries([rod(a, d, 0.9), rod(b, c, 0.9)]), look.steelLight));
      const braceLand = landing(braces, new Vector3(0, 0, 30), 0.4);
      const objects: Object3D[] = [columns.mesh, ...(plates ? [plates.mesh] : []), ...core, ...braces];
      const from = (story * 2) / segments;
      const to = (story * 2 + 1) / segments;
      const piece = add({ ...steel, layer }, layer, objects, (progress) => {
        columns.set(within(progress, 0, 0.7));
        plates?.set(within(progress, 0, 0.5));
        coreLand(within(progress, 0.1, 0.8));
        braceLand(within(progress, 0.6, 1));
      }, [from, to]);
      measure(piece);
    }
    // The floor plates: beams and metal deck under each floor above the ground, and under the roof.
    for (let story = 1; story <= stories; story++) {
      const layer = story + 1;
      const top = floorTop(story);
      const beamZ = top - TOPPING - RIBS - 3;
      const girders: Place[] = [];
      const beams: Place[] = [];
      for (const y of COLUMNS_Y) for (let index = 0; index < COLUMNS_X.length - 1; index++) girders.push({ x: (COLUMNS_X[index]! + COLUMNS_X[index + 1]!) / 2, y, z: beamZ });
      for (const x of [...COLUMNS_X, -98, 0, 98]) for (let index = 0; index < COLUMNS_Y.length - 1; index++) beams.push({ x, y: (COLUMNS_Y[index]! + COLUMNS_Y[index + 1]!) / 2, z: beamZ + 0.5, turn: quarter });
      const girderMesh = instances(beamGeometry(6, 98), look.steel, girders, new Vector3(0, 0, 40), 0.4);
      const beamMesh = instances(beamGeometry(5, 97), look.steel, beams, new Vector3(0, 0, 40), 0.4);
      // Metal deck, bay by bay: the ribs run across the beams.
      const bays: Place[] = [];
      for (let ix = 0; ix < 3; ix++) for (let iy = 0; iy < 2; iy++) bays.push({ x: X0 + 1.5 + (ix + 0.5) * 99, y: Y0 + 1.5 + (iy + 0.5) * 98.5, z: top - TOPPING - RIBS / 2 });
      const deckGeometry = box(99, 98.5, RIBS);
      const deckMesh = instances(deckGeometry, look.deck, bays, new Vector3(0, 0, 30), 0.35);
      const from = (story * 2 - 1) / segments;
      const to = (story * 2) / segments;
      const piece = add({ ...steel, layer }, layer, [girderMesh.mesh, beamMesh.mesh, deckMesh.mesh], (progress) => {
        girderMesh.set(within(progress, 0, 0.45));
        beamMesh.set(within(progress, 0.2, 0.7));
        deckMesh.set(within(progress, 0.55, 1));
      }, [from, to]);
      measure(piece);
    }
  }

  // ---------------------------------------------------------------------------------------
  // The concrete decks: edge forms and shores, mesh, the pour, the cure
  // ---------------------------------------------------------------------------------------

  for (const part of plan.parts.filter((entry) => entry.target === 'deck' && entry.layer > 1 && entry.layer <= stories)) {
    const layer = part.layer;
    const top = floorTop(storyOf(layer));
    if (part.kind === 'forms') {
      const edge = 1.4;
      const h = TOPPING + 2.2;
      const boards = [
        solid(box(W + 6, edge, h), look.plywood, 0, Y0 - 2.5, top - TOPPING + h / 2 - 1),
        solid(box(W + 6, edge, h), look.plywood, 0, Y1 + 2.5, top - TOPPING + h / 2 - 1),
        solid(box(edge, D + 6, h), look.plywood, X0 - 2.5, 0, top - TOPPING + h / 2 - 1),
        solid(box(edge, D + 6, h), look.plywood, X1 + 2.5, 0, top - TOPPING + h / 2 - 1),
      ];
      const shoreSpots: Place[] = [];
      for (const x of [-122, -74, -24, 24, 74, 122]) for (const y of [-72, -24, 24, 72]) if (!inCore(x, y, 6)) shoreSpots.push({ x, y, z: floorTop(storyOf(layer) - 1) });
      const shoreGeometry = mergeGeometries([
        new CylinderGeometry(0.9, 0.9, STORY - PLATE - 1, 6).rotateX(Math.PI / 2).translate(0, 0, (STORY - PLATE - 1) / 2),
        new BoxGeometry(5, 5, 0.8).translate(0, 0, 0.4),
        new BoxGeometry(8, 3, 1.2).translate(0, 0, STORY - PLATE - 1.6),
      ]);
      const shores = instances(shoreGeometry, look.shore, shoreSpots, new Vector3(0, 0, 18), 0.3);
      const land = landing(boards, new Vector3(0, 0, 16), 0.35);
      const cure = plan.parts.find((entry) => entry.kind === 'cure' && entry.layer === layer) ?? null;
      const piece = add(part, layer, [...boards, shores.mesh], (progress) => {
        land(within(progress, 0.4, 1), true);
        shores.set(within(progress, 0, 0.6));
        // The shores and the edge boards come out once the deck has cured, leaving the slab's own edge.
        const struck = cure ? builtBy(cure.task, dateNow) >= 1 : false;
        shores.mesh.visible = !struck;
        for (const board of boards) if (struck) board.visible = false;
      });
      measure(piece);
    } else if (part.kind === 'rebar') {
      piecesOfMesh(part, layer, top - TOPPING + 1.2);
    } else if (part.kind === 'pour') {
      const { slab, screed } = plateConcrete(layer, top - TOPPING, TOPPING);
      const piece = add(part, layer, [slab, screed], (progress) => {
        slab.visible = progress > 0;
        slab.scale.x = Math.max(0.001, progress);
        slab.position.x = X0 - 2 + ((W + 4) * progress) / 2;
        screed.visible = progress > 0 && progress < 1;
        screed.position.x = X0 - 2 + (W + 4) * progress;
      });
      measure(piece);
      pours.push({ part, layer, front: (progress, target) => target.set(X0 + W * progress, -40 + 36 * Math.sin(progress * 41), top) });
    } else if (part.kind === 'cure') {
      cures.push({ part, layer });
    }
  }

  // A plate with no pour in the plan is poured already: the steel's deck is all there is to see otherwise.
  const pouredAlready = new Set(Array.from({ length: stories }, (_, story) => story + 1).filter((layer) => !concreteFor.has(layer)));
  for (const layer of pouredAlready) {
    if (layer === groundLayer && plan.parts.some((part) => part.target === 'slab')) continue;
    const top = layer === groundLayer ? GROUND : floorTop(storyOf(layer));
    const thick = layer === groundLayer ? GROUND : TOPPING;
    const slab = solid(box(W + 4, D + 4, thick), look.concrete, 0, 0, top - thick / 2);
    layerGroups[layer]!.add(slab);
    slab.userData.standing = true;
  }

  // ---------------------------------------------------------------------------------------
  // The roof: parapet, insulation, membrane, the units on their curbs
  // ---------------------------------------------------------------------------------------

  const roofing = first('roofing');
  if (roofing) {
    const top = floorTop(stories);
    const parapetH = 8;
    const parapet = [
      solid(box(W + 6, 3, parapetH), look.concrete, 0, Y0 - 1.5, top + parapetH / 2),
      solid(box(W + 6, 3, parapetH), look.concrete, 0, Y1 + 1.5, top + parapetH / 2),
      solid(box(3, D + 6, parapetH), look.concrete, X0 - 1.5, 0, top + parapetH / 2),
      solid(box(3, D + 6, parapetH), look.concrete, X1 + 1.5, 0, top + parapetH / 2),
    ];
    const caps = [
      solid(box(W + 8, 5, 1), look.cap, 0, Y0 - 1.5, top + parapetH + 0.5),
      solid(box(W + 8, 5, 1), look.cap, 0, Y1 + 1.5, top + parapetH + 0.5),
      solid(box(5, D + 8, 1), look.cap, X0 - 1.5, 0, top + parapetH + 0.5),
      solid(box(5, D + 8, 1), look.cap, X1 + 1.5, 0, top + parapetH + 0.5),
    ];
    const boards: Place[] = [];
    for (let ix = 0; ix < 10; ix++) for (let iy = 0; iy < 7; iy++) boards.push({ x: X0 + 15 + ix * 30, y: Y0 + 14.3 + iy * 28.6, z: top + 1.1 });
    const insulation = instances(box(29.6, 28.2, 2.2), look.insulation, boards, new Vector3(0, 0, 14), 0.2);
    const membraneSheets = Array.from({ length: 6 }, (_, index) => solid(box(W / 6 + 0.2, D, 0.4), look.membrane, X0 + (index + 0.5) * (W / 6), 0, top + 2.5, false));
    const units: Mesh[] = [];
    const rtu = (w: number, d: number, h: number, x: number, y: number) => {
      const group = new Group();
      group.add(solid(box(w + 6, d + 6, 3), look.cap, 0, 0, 1.5));
      group.add(solid(rounded(w, d, h, 1.5), look.unit, 0, 0, 3 + h / 2));
      group.add(solid(box(w * 0.86, 0.6, h * 0.5), look.louver, 0, -d / 2 - 0.3, 3 + h * 0.42, false));
      group.add(solid(new CylinderGeometry(w * 0.18, w * 0.18, 2, 18).rotateX(Math.PI / 2), look.louver, w * 0.2, 0, 3 + h + 1));
      group.add(solid(new CylinderGeometry(w * 0.18, w * 0.18, 2, 18).rotateX(Math.PI / 2), look.louver, -w * 0.2, 0, 3 + h + 1));
      group.position.set(x, y, top + 2.6);
      units.push(group as unknown as Mesh);
      return group;
    };
    rtu(40, 24, 16, -60, 30);
    rtu(34, 22, 14, 10, -40);
    rtu(14, 14, 8, -110, -60);
    const penthouse = solid(rounded(CORE.x1 - CORE.x0, CORE.y1 - CORE.y0, 22, 1.2), look.concreteDark, (CORE.x0 + CORE.x1) / 2, (CORE.y0 + CORE.y1) / 2, top + 11);
    const landParapet = landing([...parapet, penthouse], new Vector3(0, 0, 16), 0.4);
    const landCaps = landing(caps, new Vector3(0, 0, 10), 0.4);
    const landMembrane = landing(membraneSheets, new Vector3(-12, 0, 0), 0.35);
    const landUnits = landing(units, new Vector3(0, 0, 60), 0.5);
    const piece = add(roofing, roof, [...parapet, ...caps, insulation.mesh, ...membraneSheets, penthouse, ...units], (progress) => {
      landParapet(within(progress, 0, 0.25));
      insulation.set(within(progress, 0.15, 0.55));
      landMembrane(within(progress, 0.5, 0.8));
      landCaps(within(progress, 0.7, 0.85));
      landUnits(within(progress, 0.78, 1));
    });
    measure(piece);
  }

  // ---------------------------------------------------------------------------------------
  // The curtain wall: unitized panels, story by story, round the building from the back
  // ---------------------------------------------------------------------------------------

  const storefront = first('storefront');
  const curtain = first('curtainwall') ?? standing('curtainwall');
  type Side = 'back' | 'right' | 'front' | 'left';
  const panelRun = (side: Side): { x: number; y: number; turn: number; out: Vector3; width: number }[] => {
    const count = side === 'back' || side === 'front' ? 12 : 8;
    const width = (side === 'back' || side === 'front' ? W : D) / count;
    return Array.from({ length: count }, (_, index) => {
      const t = (index + 0.5) / count;
      switch (side) {
        case 'back':
          return { x: lerp(X0, X1, t), y: Y1 + 2, turn: 0, out: new Vector3(0, 30, 10), width };
        case 'right':
          return { x: X1 + 2, y: lerp(Y1, Y0, t), turn: quarter, out: new Vector3(30, 0, 10), width };
        case 'front':
          return { x: lerp(X1, X0, t), y: Y0 - 2, turn: 0, out: new Vector3(0, -30, 10), width };
        default:
          return { x: X0 - 2, y: lerp(Y0, Y1, t), turn: quarter, out: new Vector3(-30, 0, 10), width };
      }
    });
  };
  const cutawayMaterials = [look.glassNear, look.frameNear, look.spandrelNear];
  if (curtain) {
    for (let story = 0; story < stories; story++) {
      const layer = story + 1;
      const base = floorTop(story);
      const h = STORY;
      const sides: Side[] = ['back', 'right', 'front', 'left'];
      const runs = sides.flatMap((side) => (story === 0 && side === 'front' && storefront ? [] : panelRun(side).map((panel) => ({ ...panel, side }))));
      const near = (side: Side) => side === 'front' || side === 'left';
      const starts = startsFor(runs.length, 0.25);
      const build = (subset: typeof runs, startsOf: number[], glass: Material, frame: Material, spandrel: Material) => {
        const panes = instances(box(25 - 2.2, 0.6, h - 13), glass, subset.map((panel, index) => ({ x: panel.x, y: panel.y, z: base + 4 + (h - 13) / 2, turn: panel.turn, at: startsOf[index]! })), new Vector3(0, 0, 0), 0.25);
        const mullions = instances(box(1.6, 3.2, h), frame, subset.map((panel, index) => ({ x: panel.x + (panel.turn ? 0 : -panel.width / 2 + 0.8), y: panel.y + (panel.turn ? -panel.width / 2 + 0.8 : 0), z: base + h / 2 - 2.5, turn: panel.turn, at: startsOf[index]! })), new Vector3(0, 0, 0), 0.25);
        const transoms = instances(box(25, 2.6, 1.6), frame, subset.map((panel, index) => ({ x: panel.x, y: panel.y, z: base + h * 0.62, turn: panel.turn, at: startsOf[index]! })), new Vector3(0, 0, 0), 0.25);
        const bands = instances(box(25, 3.4, 9.5), spandrel, subset.map((panel, index) => ({ x: panel.x, y: panel.y, z: base + h - 6.5, turn: panel.turn, at: startsOf[index]! })), new Vector3(0, 0, 0), 0.25);
        panes.mesh.castShadow = false;
        return [panes, mullions, transoms, bands];
      };
      const farRuns = runs.filter((panel) => !near(panel.side));
      const nearRuns = runs.filter((panel) => near(panel.side));
      const farStarts = runs.map((panel, index) => (!near(panel.side) ? starts[index]! : -1)).filter((at) => at >= 0);
      const nearStarts = runs.map((panel, index) => (near(panel.side) ? starts[index]! : -1)).filter((at) => at >= 0);
      const far = build(farRuns, farStarts, look.glassFar, look.frame, look.spandrel);
      const close = build(nearRuns, nearStarts, look.glassNear, look.frameNear, look.spandrelNear);
      // The panels swing in from outside, each from its own side.
      const all = [...far, ...close];
      const piece = add({ ...curtain, layer }, layer, all.map((entry) => entry.mesh), (progress) => {
        for (const entry of all) entry.set(progress);
      }, [story / stories, (story + 1) / stories], true);
      for (const entry of close) entry.mesh.userData.near = true;
      measure(piece);
    }
  }

  // The ground floor's front: tall glass, the doors and a canopy with the building's name on it.
  if (storefront) {
    const base = GROUND;
    const h = STORY - PLATE;
    const panels: Mesh[] = [];
    const frames: BufferGeometry[] = [];
    for (let index = 0; index < 10; index++) {
      const x = X0 + 15 + index * 30;
      if (Math.abs(x) < 20) continue;
      panels.push(solid(box(28, 0.6, h - 4), look.glassNear, x, Y0 - 2, base + (h - 4) / 2 + 1, false));
      frames.push(box(2, 3, h).translate(x - 15, Y0 - 2, base + h / 2));
    }
    frames.push(box(2, 3, h).translate(X1, Y0 - 2, base + h / 2), box(W, 3, 2).translate(0, Y0 - 2, base + h - 1), box(W, 3, 1.6).translate(0, Y0 - 2, base + 0.8));
    const frame = solid(mergeGeometries(frames), look.frameNear);
    const doors = solid(mergeGeometries([box(18, 1, 28).translate(-9.5, 0, 14), box(18, 1, 28).translate(9.5, 0, 14), box(40, 3, 3).translate(0, 0, 29.5), box(1.4, 3, 30).translate(-19.5, 0, 15), box(1.4, 3, 30).translate(19.5, 0, 15)]), look.frameNear, 0, Y0 - 1, base);
    const doorGlass = solid(mergeGeometries([box(15, 0.4, 25).translate(-9.5, -0.6, 14), box(15, 0.4, 25).translate(9.5, -0.6, 14)]), look.glassNear, 0, Y0 - 1, base, false);
    const nameCanvas = document.createElement('canvas');
    nameCanvas.width = 1024;
    nameCanvas.height = 64;
    const namePaint = nameCanvas.getContext('2d')!;
    namePaint.fillStyle = '#2b3036';
    namePaint.fillRect(0, 0, 1024, 64);
    namePaint.fillStyle = '#efece4';
    namePaint.font = '600 34px Inter, "Helvetica Neue", Arial, sans-serif';
    namePaint.textAlign = 'center';
    namePaint.textBaseline = 'middle';
    (namePaint as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '14px';
    namePaint.fillText('HARBOR STREET OFFICES', 512, 34);
    const nameTexture = new CanvasTexture(nameCanvas);
    nameTexture.colorSpace = SRGBColorSpace;
    nameTexture.anisotropy = 8;
    const fascia = own(new MeshStandardMaterial({ map: nameTexture, roughness: 0.5, metalness: 0.2 }));
    const canopy = new Mesh(box(96, 30, 4), [look.cap, look.cap, look.cap, fascia, look.ceiling, look.ceiling]);
    canopy.position.set(0, Y0 - 15, base + 36);
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    const land = landing([frame, ...panels, doors, doorGlass, canopy], new Vector3(0, -24, 0), 0.3);
    const piece = add(storefront, groundLayer, [frame, ...panels, doors, doorGlass, canopy], (progress) => land(progress), [0, 1], true);
    frame.userData.near = true;
    doors.userData.near = true;
    measure(piece);
  }

  // ---------------------------------------------------------------------------------------
  // The lobby: a stone floor, an oak wall, the desk, the lights
  // ---------------------------------------------------------------------------------------

  const lobby = first('lobby');
  const lobbyGlow: MeshStandardMaterial[] = [];
  if (lobby) {
    const z = GROUND;
    const tiles: Place[] = [];
    const tones: Color[] = [];
    const stone = [new Color('#e9e5dd'), new Color('#e2ddd4'), new Color('#ece9e2')];
    for (let ix = 0; ix < 12; ix++)
      for (let iy = 0; iy < 9; iy++) {
        const x = X0 + 12.5 + ix * 25;
        const y = Y0 + 11 + iy * 22;
        if (inCore(x, y, 6)) continue;
        tiles.push({ x, y, z: z + 0.45 });
        tones.push(stone[(ix * 5 + iy * 3) % stone.length]!);
      }
    const floor = instances(box(24.6, 21.6, 0.9), look.stone, tiles, new Vector3(0, 0, 8), 0.2, tones);
    const slats: Place[] = [];
    for (let x = -136; x <= 92; x += 4.5) slats.push({ x, y: Y1 - 4, z: z + 24 });
    const wall = instances(box(2, 2.4, 46), look.oak, slats, new Vector3(0, 0, 20), 0.25);
    const deskParts = [solid(rounded(64, 14, 11, 1.5), look.desk, -20, 26, z + 5.5), solid(box(66, 15, 1.2), look.oak, -20, 26, z + 11.6)];
    const glow = own(look.glow.clone());
    lobbyGlow.push(glow);
    const pendants = [-48, -28, -8, 12].map((x) => {
      const group = new Group();
      group.add(solid(new CylinderGeometry(0.2, 0.2, 18, 4).rotateX(Math.PI / 2), look.conduit, 0, 0, 9, false));
      group.add(solid(new CylinderGeometry(3.2, 3.2, 5, 18).rotateX(Math.PI / 2), glow, 0, 0, -1, false));
      group.position.set(x, 26, z + 32);
      return group;
    });
    const planters = [
      [-120, -70],
      [-120, 70],
      [80, -70],
    ].map(([x, y]) => {
      const group = new Group();
      group.add(solid(rounded(14, 14, 10, 1.5), look.planter, 0, 0, 5));
      group.add(solid(new SphereGeometry(9, 8, 6), look.leaf, 0, 0, 18));
      group.position.set(x!, y!, z);
      return group;
    });
    const land = landing([...deskParts, ...pendants, ...planters], new Vector3(0, 0, 18), 0.3);
    const piece = add(lobby, groundLayer, [floor.mesh, wall.mesh, ...deskParts, ...pendants, ...planters], (progress) => {
      floor.set(within(progress, 0, 0.45));
      wall.set(within(progress, 0.3, 0.75));
      land(within(progress, 0.65, 1));
      glow.emissiveIntensity = progress >= 1 ? 2.6 : 0;
    });
    measure(piece);
  }

  // ---------------------------------------------------------------------------------------
  // An office floor's fit-out, in the order the trades follow each other
  // ---------------------------------------------------------------------------------------

  const floorLights: { layer: number; set(on: number, time: number): void }[] = [];
  let lightsHeld: ((layer: number) => number) | null = null;
  for (let story = 1; story < stories; story++) {
    const layer = story + 1;
    const z = floorTop(story);
    const at = (kind: PartKind) => plan.parts.filter((part) => part.layer === layer && part.kind === kind);
    const hasLights = at('lights').length > 0;

    for (const part of at('layout')) {
      const lines = WALLS.map(([x1, y1, x2, y2]) => {
        const length = Math.hypot(x2 - x1, y2 - y1);
        const line = new Mesh(Math.abs(y2 - y1) > Math.abs(x2 - x1) ? new PlaneGeometry(1.1, length) : new PlaneGeometry(length, 1.1), look.chalk);
        line.position.set((x1 + x2) / 2, (y1 + y2) / 2, z + 0.25);
        return line;
      });
      const piece = add(part, layer, lines, ((land) => (progress: number) => land(progress))(landing(lines, new Vector3(0, 0, 0), 0.2)));
      measure(piece);
    }

    for (const part of at('partitions')) {
      const studPlaces: Place[] = WALLS.flatMap((wall) => along(wall, 8).map((point) => ({ x: point.x, y: point.y, z: z + CEIL / 2, turn: point.turned ? quarter : 0 })));
      const studs = instances(box(2, 3.4, CEIL), look.stud, studPlaces, new Vector3(0, 0, 28), 0.25);
      const tracks = WALLS.flatMap(([x1, y1, x2, y2]) => {
        const length = Math.hypot(x2 - x1, y2 - y1);
        const turned = Math.abs(y2 - y1) > Math.abs(x2 - x1);
        const track = (height: number) => solid(turned ? box(3.6, length, 1.1) : box(length, 3.6, 1.1), look.stud, (x1 + x2) / 2, (y1 + y2) / 2, z + height);
        return [track(0.55), track(CEIL - 0.55)];
      });
      const land = landing(tracks, new Vector3(0, 0, 18), 0.3);
      const piece = add(part, layer, [studs.mesh, ...tracks], (progress) => {
        studs.set(progress);
        land(progress);
      });
      measure(piece);
    }

    for (const part of at('rough')) {
      const plenum = z + CEIL + (STORY - PLATE - CEIL) / 2;
      const runs: Mesh[] = [];
      for (const x of [-118, -62, -6, 50]) runs.push(solid(rounded(54, 15, 6, 1), look.duct, x, -4, plenum));
      for (const x of [-118, -62, -6, 50]) runs.push(solid(rounded(8, 50, 4, 1), look.duct, x, -38, plenum - 1));
      for (const x of [-118, -62, -6]) runs.push(solid(rounded(8, 34, 4, 1), look.duct, x, 20, plenum - 1));
      runs.push(solid(box(268, 1.6, 1.6), look.conduit, -10, -72, plenum + 1.5), solid(box(268, 1.6, 1.6), look.conduit, -10, -68, plenum + 1.5));
      runs.push(solid(new CylinderGeometry(1.2, 1.2, 240, 10).rotateZ(Math.PI / 2), look.pipe, -24, 64, plenum + 2));
      const piece = add(part, layer, runs, ((land) => (progress: number) => land(progress))(landing(runs, new Vector3(0, 0, -16), 0.3)));
      measure(piece);
    }

    // Drywall, then paint: the boards turn from bare to painted, one wall in the accent color.
    const bare = new Color('#cfccc4');
    const painted = new Color('#f3f0ea');
    const accent = new Color('#b9c6b4');
    const boardPlaces = WALLS.flatMap((wall, index) => along(wall, 16).map((point) => ({ x: point.x, y: point.y, z: z + CEIL / 2, turn: point.turned ? quarter : 0, wall: index })));
    let boards: { mesh: InstancedMesh; set(progress: number): void } | null = null;
    let boardsPiece: Piece | null = null;
    for (const part of at('drywall')) {
      const material = own(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.86 }));
      boards = instances(box(16 - 0.4, 4.8, CEIL - 0.6), material, boardPlaces, new Vector3(0, -22, 0), 0.3, boardPlaces.map(() => bare));
      const mesh = boards;
      const piece = add(part, layer, [mesh.mesh], (progress) => mesh.set(progress));
      measure(piece);
      boardsPiece = piece;
    }
    for (const part of at('paint')) {
      const target = boards;
      const starts = startsFor(boardPlaces.length, 0.35);
      const shade = new Color();
      let last = -1;
      const piece = add(part, layer, [], (progress) => {
        if (!target || progress === last) return;
        last = progress;
        boardPlaces.forEach((place, index) => {
          const t = smooth(within(progress, starts[index]!, starts[index]! + 0.35));
          target.mesh.setColorAt(index, shade.copy(bare).lerp(place.wall === ACCENT_WALL ? accent : painted, t));
        });
        if (target.mesh.instanceColor) target.mesh.instanceColor.needsUpdate = true;
      });
      // Paint shows on the boards, so selecting it picks them out.
      if (target) piece.objects.push(target.mesh);
      if (boardsPiece) piece.box.copy(boardsPiece.box);
    }

    // The ceiling: tees, then the light fixtures in some of its cells and tiles in the rest.
    const cells: { x: number; y: number; light: boolean }[] = [];
    for (let iy = 0; iy < GRID_ROWS; iy++)
      for (let ix = 0; ix < W / CELL_W; ix++) {
        const x = X0 + (ix + 0.5) * CELL_W;
        const y = GRID_Y0 + (iy + 0.5) * CELL_D;
        if (!inCore(x, y)) cells.push({ x, y, light: hasLights && isLightCell(ix, iy) });
      }
    for (const part of at('grid')) {
      const tees: Mesh[] = [];
      for (let row = 0; row <= GRID_ROWS; row++) {
        const y = GRID_Y0 + row * CELL_D;
        const right = y > CORE.y0 - 2 ? CORE.x0 - 2 : X1;
        tees.push(solid(box(right - X0, 1.1, 1.3), look.ceiling, (X0 + right) / 2, y, z + CEIL, false));
      }
      for (let column = 0; column <= W / CELL_W; column++) {
        const x = X0 + column * CELL_W;
        const far = x > CORE.x0 - 2 ? CORE.y0 - 2 : GRID_Y0 + GRID_ROWS * CELL_D;
        tees.push(solid(box(1.1, far - GRID_Y0, 1.3), look.ceiling, x, (GRID_Y0 + far) / 2, z + CEIL, false));
      }
      const piece = add(part, layer, tees, ((land) => (progress: number) => land(progress))(landing(tees, new Vector3(0, 0, -10), 0.25)));
      measure(piece);
    }
    for (const part of at('tiles')) {
      const tiles = instances(box(CELL_W - 1.5, CELL_D - 1.5, 1.1), look.tile, cells.filter((cell) => !cell.light).map((cell) => ({ x: cell.x, y: cell.y, z: z + CEIL + 0.7 })), new Vector3(0, 0, -6), 0.15);
      tiles.mesh.castShadow = false;
      const piece = add(part, layer, [tiles.mesh], (progress) => tiles.set(progress));
      measure(piece);
    }
    const lightCells = cells.filter((cell) => cell.light);
    for (const part of at('delivery')) {
      const crates: Mesh[] = [];
      for (let index = 0; index < 6; index++) crates.push(solid(rounded(13, 9, 6, 0.6), look.crate, 70 + (index % 3) * 13.6, 18 + Math.floor(index / 3) * 9.6, z + 3 + Math.floor(index / 3) * 0));
      for (let index = 0; index < 3; index++) crates.push(solid(rounded(13, 9, 6, 0.6), look.crate, 70 + index * 13.6, 22.8, z + 9.2));
      const lights = at('lights')[0] ?? null;
      const land = landing(crates, new Vector3(0, 0, 20), 0.3);
      const piece = add(part, layer, crates, (progress) => {
        land(progress, true);
        // The crates empty as the fixtures go up.
        if (lights) {
          const used = builtBy(lights.task, dateNow);
          crates.forEach((crate, index) => {
            if (used > 1 - index / crates.length) crate.visible = false;
          });
        }
      });
      measure(piece);
    }
    for (const part of at('wiring')) {
      const whips = instances(box(0.7, 0.7, STORY - PLATE - CEIL), look.conduit, lightCells.map((cell) => ({ x: cell.x + 8, y: cell.y, z: z + CEIL + (STORY - PLATE - CEIL) / 2 })), new Vector3(0, 0, 8), 0.3);
      whips.mesh.castShadow = false;
      const piece = add(part, layer, [whips.mesh], (progress) => whips.set(progress));
      measure(piece);
    }
    const glow = own(look.glow.clone());
    for (const part of at('lights')) {
      const fixtures = instances(rounded(CELL_W - 2, CELL_D - 2, 2.2, 0.7), glow, lightCells.map((cell) => ({ x: cell.x, y: cell.y, z: z + CEIL - 0.4 })), new Vector3(0, 0, -14), 0.3);
      fixtures.mesh.castShadow = false;
      const piece = add(part, layer, [fixtures.mesh], (progress) => fixtures.set(progress));
      measure(piece);
    }
    for (const part of at('flooring')) {
      const carpet = own(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.97 }));
      const places: Place[] = [];
      const colors: Color[] = [];
      const tones = [new Color('#6a7079'), new Color('#727881'), new Color('#656b73')];
      for (let iy = 0; iy < 10; iy++)
        for (let ix = 0; ix < 15; ix++) {
          const x = X0 + 10 + ix * 20;
          const y = Y0 + 10 + iy * 20;
          if (inCore(x, y)) continue;
          places.push({ x, y, z: z + 0.45 });
          colors.push(tones[(ix * 7 + iy * 3) % tones.length]!);
        }
      const tiles = instances(box(19.5, 19.5, 0.9), carpet, places, new Vector3(0, 0, 8), 0.2, colors);
      tiles.mesh.castShadow = false;
      const piece = add(part, layer, [tiles.mesh], (progress) => tiles.set(progress));
      measure(piece);
    }

    // Lights on: as they are tested, or once they are in when nothing tests them; a warm wash on the floor.
    const testPart = at('test')[0] ?? null;
    const lightsPart = at('lights')[0] ?? null;
    if (lightsPart) {
      const wash = own(new MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }));
      const floorWash = new Mesh(new PlaneGeometry(W - 8, D - 8), wash);
      floorWash.position.set(0, 0, z + 1.4);
      floorWash.renderOrder = 2;
      floorWash.visible = false;
      layerGroups[layer]!.add(floorWash);
      const lamp = new PointLight('#ffdcae', 0, 260, 1.6);
      lamp.position.set(-20, -10, z + CEIL - 6);
      layerGroups[layer]!.add(lamp);
      floorLights.push({
        layer,
        set(_on, time) {
          const tested = testPart ? builtBy(testPart.task, dateNow) : builtBy(lightsPart.task, dateNow) >= 1 ? 1 : 0;
          const on = lightsHeld ? lightsHeld(layer) : tested <= 0 ? 0 : smooth(clamp01(tested * 1.3)) * (tested < 1 ? 0.9 + 0.1 * Math.sin(time * 21) : 1);
          glow.emissiveIntensity = on * 3.2;
          // Held for the dusk shot, the room's light comes from the wash more than from one lamp: in the dark, a lamp near a wall shows as a hot spot.
          wash.opacity = on * (lightsHeld ? 0.2 : 0.11);
          floorWash.visible = on > 0.01;
          lamp.intensity = on * (lightsHeld ? 1300 : 2600);
        },
      });
    }
  }

  // ---------------------------------------------------------------------------------------
  // The site's own work: mobilizing, the dig, the backfill, the handover
  // ---------------------------------------------------------------------------------------

  const mobilize = first('mobilize');
  const excavate = first('excavate');
  const strip = partsOf('strip')[0] ?? null;
  const handover = first('handover');
  function strippedBy(part: Part): number {
    return builtBy(part.task, dateNow);
  }

  // ---------------------------------------------------------------------------------------
  // The machines: the crane on its rental, the pump and mixer on pour days, the excavator, the lifts
  // ---------------------------------------------------------------------------------------

  const machines = machineMaterials();
  owned.push(...Object.values(machines));
  const idleRings = options.idleRings !== false;
  const craneBooking = plan.bookings.find((booking) => booking.machine.kind === 'crane') ?? null;
  const crane: TowerCrane | null = craneBooking || steel.task.id !== -1 ? towerCrane(machines) : null;
  const ringMaterial = own(new MeshBasicMaterial({ color: '#ea9a1c', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  const craneRing = new Mesh(new RingGeometry(46, 60, 64), ringMaterial);
  craneRing.position.set(CRANE_AT.x, CRANE_AT.y, 0.6);
  craneRing.renderOrder = 3;
  root.add(craneRing);
  const steelLoad = new Group();
  for (let index = 0; index < 3; index++) {
    const member = new Mesh(beamGeometry(4.4, 64), look.steel);
    member.position.set(0, (index - 1) * 5, 0);
    member.castShadow = true;
    steelLoad.add(member);
  }
  const slings = new Mesh(mergeGeometries([rod(new Vector3(0, 0, 10), new Vector3(-26, 0, 2), 0.25, 4), rod(new Vector3(0, 0, 10), new Vector3(26, 0, 2), 0.25, 4)]), machines.dark);
  steelLoad.add(slings);
  const laydown = new Group();
  for (let index = 0; index < 5; index++) {
    const member = new Mesh(beamGeometry(4.4, 70), look.steel);
    member.position.set(0, (index % 3) * 6 - 6, 3 + Math.floor(index / 3) * 5);
    member.castShadow = true;
    laydown.add(member);
  }
  laydown.add(solid(box(4, 22, 2), look.plywood, -24, -2, 1), solid(box(4, 22, 2), look.plywood, 24, -2, 1));
  laydown.position.set(LAYDOWN.x, LAYDOWN.y - 18, 0);
  root.add(laydown);
  if (crane) {
    crane.root.position.set(CRANE_AT.x, CRANE_AT.y, 0);
    root.add(crane.root);
  }

  const pump = plan.parts.some((part) => part.kind === 'pour') ? pumpTruck(machines) : null;
  const mixer = pump ? mixerTruck(machines) : null;
  if (pump && mixer) {
    pump.root.position.set(PUMP_AT.x, PUMP_AT.y, 0);
    mixer.root.position.set(MIXER_AT.x, MIXER_AT.y, 0);
    mixer.root.rotation.z = Math.PI;
    root.add(pump.root, mixer.root);
  }

  const excavator = excavate ? realExcavatorOf(options.props ?? null) : null;
  if (excavator) root.add(excavator.root);

  const liftBeacon = own(machines.beacon.clone());
  const lifts = plan.bookings
    .filter((booking) => booking.machine.kind === 'lift')
    .map((booking, index) => {
      const lift = scissorLift(machines);
      const spot = index % 2 === 0 ? { x: -60, y: -46 } : { x: 0, y: -52 };
      lift.root.position.set(spot.x, spot.y, floorTop(storyOf(booking.layer)) + 0.2);
      layerGroups[Math.max(0, Math.min(layerGroups.length - 1, booking.layer))]!.add(lift.root);
      const ring = new Mesh(new RingGeometry(16, 21, 48), ringMaterial);
      ring.position.set(spot.x, spot.y, floorTop(storyOf(booking.layer)) + 0.8);
      ring.renderOrder = 3;
      layerGroups[Math.max(0, Math.min(layerGroups.length - 1, booking.layer))]!.add(ring);
      const beacon = new Mesh(new SphereGeometry(1.6, 12, 8), liftBeacon);
      lift.root.add(beacon);
      return { booking, lift, ring, beacon, spot };
    });

  // ---------------------------------------------------------------------------------------
  // People: a few of each crew at work on what is under way
  // ---------------------------------------------------------------------------------------

  const crews = new Map<number, Worker[]>();
  const workersKit = options.workers ?? null;
  const placeCrew = (part: Part, layer: number, area: { x: number; y: number; w: number; d: number }, z: number, active: boolean) => {
    let crew = crews.get(part.task.id);
    if (!active) {
      if (crew) for (const worker of crew) worker.root.visible = false;
      return;
    }
    if (!crew && workersKit) {
      const people = Math.min(4, Math.max(2, part.task.crews[0]?.people ?? 2));
      const color = part.task.crews[0]?.color ?? '#e7ad1c';
      crew = Array.from({ length: people }, (_, index) => {
        const worker = workersKit.spawn(color, 21, part.task.id * 7 + index);
        worker.setOnSite(true);
        return worker;
      });
      crews.set(part.task.id, crew);
    }
    if (!crew) return;
    crew.forEach((worker, index) => {
      if (worker.root.parent !== layerGroups[layer]) layerGroups[layer]!.add(worker.root);
      if (!worker.root.visible || worker.root.userData.area !== `${area.x},${area.y}`) {
        const spotX = area.x - area.w / 2 + ((index + 0.5) / crew!.length) * area.w;
        worker.standAt(spotX, area.y + ((index % 2) - 0.5) * area.d * 0.3, area);
        worker.root.position.z = z;
        worker.root.userData.area = `${area.x},${area.y}`;
      }
      worker.root.visible = true;
    });
  };

  // ---------------------------------------------------------------------------------------
  // Setting the date
  // ---------------------------------------------------------------------------------------

  let lastDate = Number.NaN;
  const curedOf = (layer: number) => cures.find((entry) => entry.layer === layer) ?? null;

  function setDate(date: number) {
    dateNow = date;
    if (date === lastDate) return;
    lastDate = date;
    drawOutlines();
    for (const piece of pieces) {
      const progress = builtBy(piece.task, date);
      piece.set(within(progress, piece.range[0], piece.range[1]), 0);
    }
    // Concrete: wet as it is poured, drying through its cure (or at once, when there is no cure in the plan).
    for (const [layer, material] of concreteFor) {
      const cure = curedOf(layer);
      const pour = pours.find((entry) => entry.layer === layer);
      const dry = cure ? builtBy(cure.part.task, date) : pour && builtBy(pour.part.task, date) >= 1 ? 1 : 0;
      material.color.copy(wetColor).lerp(curedColor, smooth(dry));
      material.roughness = lerp(0.16, 0.9, smooth(dry));
      material.clearcoat = lerp(0.7, 0, smooth(dry));
    }
    // The site: the works from mobilizing to the handover, the dig and its fill.
    const mobilized = mobilize ? date >= mobilize.task.start : true;
    const handedOver = handover ? within(date, handover.task.start - 0.5 * 86_400_000, handover.task.start) : 0;
    site.setWorks(mobilized && handedOver < 0.5 ? 1 : 0);
    site.setFinished(handedOver);
    const dug = excavate ? builtBy(excavate.task, date) : 0;
    const filled = strip ? within(builtBy(strip.task, date), 0.4, 1) : 0;
    site.setDig(excavate ? dug * (1 - filled) : 0);
    site.setSpoil(excavate ? dug * (1 - filled * 0.85) : 0);
    // Steel waits in the lay-down while it is being erected.
    laydown.visible = steel.task.id !== -1 && date >= steel.task.start - 3 * 86_400_000 && builtBy(steel.task, date) < 0.92;
  }

  // ---------------------------------------------------------------------------------------
  // Moves of their own
  // ---------------------------------------------------------------------------------------

  const hook = new Vector3();
  const aim = new Vector3();
  const front = new Vector3();

  function craneAim(x: number, y: number) {
    return { heading: Math.atan2(y - CRANE_AT.y, x - CRANE_AT.x), reach: Math.hypot(x - CRANE_AT.x, y - CRANE_AT.y) };
  }
  const parked = craneAim(-30, 10);
  const pickup = craneAim(LAYDOWN.x, LAYDOWN.y - 18);
  /** Where someone riding the crane has it hang its hook, and how far round it has swung there (0 to 1). */
  let heldOver: { heading: number; reach: number; hookZ: number } | null = null;
  let holding = false;
  let held = 0;
  /** Round to the hook's place in a second, for a camera that gets there as quickly; let go, it drifts back slowly. */
  const HOLD_SECONDS = 1;
  const LET_GO_SECONDS = 4;
  const targets = [
    [-100, -50],
    [40, 30],
    [-30, 60],
    [110, -40],
    [-130, 50],
    [0, -70],
  ];

  function turnTo(from: number, to: number, t: number): number {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return from + delta * t;
  }

  function update(dt: number, time: number) {
    const date = dateNow;
    ringMaterial.opacity = 0.55 + 0.3 * Math.sin(time * 3);
    // The crane: on site while it is on rent, lifting steel on its work days, parked with its beacon on otherwise.
    if (crane) {
      const span = steel ? date >= steel.task.start && date < steel.task.end : false;
      const on = craneBooking ? machineOn(craneBooking, date) : { booked: span, working: span, idle: false };
      crane.root.visible = on.booked;
      const idle = on.idle;
      crane.beacon(idle, time);
      craneRing.visible = idle && idleRings;
      held = clamp01(held + (holding && on.booked ? dt / HOLD_SECONDS : -dt / LET_GO_SECONDS));

      if (on.working && steel) {
        const progress = builtBy(steel.task, date);
        const story = Math.min(stories - 1, Math.floor(progress * stories));
        const deck = floorTop(story + 1) + offsets[story + 2 > roof ? roof : story + 2]! + 6;
        const cycle = 7;
        const pick = Math.floor(time / cycle);
        const u = (time % cycle) / cycle;
        const [tx, ty] = targets[pick % targets.length]!;
        const target = craneAim(tx!, ty!);
        const high = Math.max(deck + 70, 160);
        let heading: number;
        let reach: number;
        let hookZ: number;
        if (u < 0.14) {
          heading = pickup.heading;
          reach = pickup.reach;
          hookZ = lerp(18, high, smooth(within(u, 0.03, 0.14)));
        } else if (u < 0.5) {
          const t = smooth(within(u, 0.14, 0.5));
          heading = turnTo(pickup.heading, target.heading, t);
          reach = lerp(pickup.reach, target.reach, t);
          hookZ = high;
        } else if (u < 0.7) {
          heading = target.heading;
          reach = target.reach;
          hookZ = lerp(high, deck + 16, smooth(within(u, 0.5, 0.64)));
        } else {
          const t = smooth(within(u, 0.7, 1));
          heading = turnTo(target.heading, pickup.heading, t);
          reach = lerp(target.reach, pickup.reach, t);
          hookZ = lerp(deck + 30, 18, t);
        }
        crane.pose(heading, reach, hookZ);
        crane.carry(u < 0.66 ? steelLoad : null);
        steelLoad.rotation.z = Math.PI / 2;
      } else {
        // Idle, a tower crane is left to weathervane: its jib drifts round with the wind, over nothing.
        const heading = parked.heading + (idle ? Math.sin(time * 0.11) * 0.8 : Math.sin(time * 0.25) * 0.02);
        const hookZ = crane.height - 40;
        if (heldOver && held > 0) {
          // Ridden: round over the lot, the trolley out and the hook let down, then still but for a breath of wind.
          const t = smooth(held);
          crane.pose(turnTo(heading, heldOver.heading + jibSway(time), t), lerp(parked.reach, heldOver.reach, t), lerp(hookZ, heldOver.hookZ, t));
        } else crane.pose(heading, parked.reach, hookZ);
        crane.carry(null);
      }
      void hook;
    }

    // The pump and the mixer, on the street, on a pour day.
    if (pump && mixer) {
      const active = pours.find((entry) => {
        const progress = builtBy(entry.part.task, date);
        return progress > 0 && progress < 1;
      });
      pump.root.visible = Boolean(active);
      mixer.root.visible = Boolean(active);
      if (active) {
        const progress = builtBy(active.part.task, date);
        active.front(progress, front);
        front.z += offsets[active.layer]!;
        aim.set(front.x - PUMP_AT.x, front.y - PUMP_AT.y, front.z);
        pump.reach(aim, time);
        mixer.spin(time);
      }
    }

    // The excavator in the dig, working across it.
    if (excavator && excavate) {
      const digging = builtBy(excavate.task, date);
      const filling = strip ? builtBy(strip.task, date) : 0;
      const busy = (digging > 0 && digging < 1) || (filling > 0 && filling < 1);
      excavator.root.visible = busy;
      if (busy) {
        const across = digging < 1 ? digging : filling;
        excavator.root.position.set(lerp(-110, 110, across), lerp(-70, -40, across), -DIG.depth * (digging < 1 ? digging : 1 - filling) + 0.5);
        excavator.root.rotation.z = Math.PI / 2;
        const swing = Math.sin(time * 1.3);
        excavator.pose(0.6 * swing, 0.5 + 0.25 * Math.sin(time * 2.1), 0.9 + 0.3 * Math.cos(time * 2.1), 0.4 + 0.4 * Math.sin(time * 2.6));
      }
    }

    // The lifts: up under the ceiling with someone on it while there is work, down with the beacon on when not.
    for (const each of lifts) {
      const on = machineOn(each.booking, date);
      each.lift.root.visible = on.booked;
      each.ring.visible = on.idle && idleRings;
      each.lift.rise(on.working ? CEIL - 24 : 12);
      each.beacon.position.set(-12, 0, (on.working ? CEIL - 24 : 12) + 16);
      liftBeacon.emissiveIntensity = on.idle ? 1.4 + 2.4 * Math.max(0, Math.sin(time * 4.6)) : 0;
    }

    // People at work on what is under way.
    for (const part of plan.parts) {
      const progress = builtBy(part.task, date);
      const active = progress > 0 && progress < 1 && part.kind !== 'order' && part.kind !== 'cure' && part.kind !== 'handover';
      if (!active && !crews.has(part.task.id)) continue;
      const pieceList = byTask.get(part.task.id) ?? [];
      const current = pieceList.find((piece) => {
        const local = within(progress, piece.range[0], piece.range[1]);
        return local > 0 && local < 1;
      }) ?? pieceList[0];
      if (!current) {
        placeCrew(part, Math.max(0, part.layer), { x: 0, y: -40, w: 160, d: 80 }, floorTop(Math.max(0, storyOf(Math.max(1, part.layer)))), active);
        continue;
      }
      const layer = current.layer;
      const z = layer === FOUNDATIONS ? (part.kind === 'mobilize' ? 0 : -DIG.depth * 0.5) : layer === roof ? floorTop(stories) + 3 : floorTop(storyOf(layer)) + (part.target === 'deck' ? 0 : 0.5);
      const center = current.box.getCenter(new Vector3());
      const span = current.box.getSize(new Vector3());
      placeCrew(part, layer, { x: MathUtils.clamp(center.x, X0 + 20, X1 - 20), y: MathUtils.clamp(center.y, Y0 + 20, Y1 - 20), w: Math.min(160, Math.max(40, span.x * 0.6)), d: Math.min(120, Math.max(30, span.y * 0.6)) }, z, active);
    }
    for (const crew of crews.values()) for (const worker of crew) if (worker.root.visible) worker.update(dt);

    for (const light of floorLights) light.set(1, time);
  }

  // ---------------------------------------------------------------------------------------
  // Paint: ghosts, tints, the piece under the pointer
  // ---------------------------------------------------------------------------------------

  const ghost = own(new MeshStandardMaterial({ color: '#c8d3dd', transparent: true, opacity: 0.16, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  const unseen = own(new MeshBasicMaterial({ visible: false }));
  const tints = new Map<string, MeshStandardMaterial>();
  const tintOf = (color: string) => {
    let material = tints.get(color);
    if (!material) {
      material = own(new MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05 }));
      tints.set(color, material);
    }
    return material;
  };
  const hoverMaterials = new Map<Material, Material>();
  const hoverOf = (base: Material) => {
    let material = hoverMaterials.get(base);
    if (!material) {
      material = own((base as MeshStandardMaterial).clone());
      const standard = material as MeshStandardMaterial;
      if (standard.emissive) {
        standard.emissive = new Color('#ffb84d');
        standard.emissiveIntensity = 0.42;
      }
      hoverMaterials.set(base, material);
    }
    return material;
  };
  let rule: PaintRule = {};
  let cutaway = 0;

  function setPaint(next: PaintRule) {
    rule = next;
    for (const piece of pieces) {
      const id = piece.task.id;
      const kept = !rule.keep || rule.keep(id, piece.layer);
      const tint = kept && rule.tint ? rule.tint(id) : null;
      for (const object of piece.objects) {
        const base = object.userData.base as Material;
        let material: Material = base;
        // The glass at the front stays open while someone looks inside, whatever it is painted.
        const opened = cutaway > 0.5 && cutawayMaterials.includes(base as never);
        const gone = Boolean(rule.hidden?.(id));
        if (gone) material = unseen;
        else if (opened) material = base;
        else if (!kept) material = ghost;
        else if (tint && !(piece.glassy && base === look.glassFar)) material = tintOf(tint);
        if (kept && !opened && !gone && rule.hover === id) material = hoverOf(material === base ? base : material);
        object.material = material;
        object.castShadow = kept && !gone && !(piece.glassy && (base === look.glassFar || base === look.glassNear));
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // The building it is going to be: each story's outline, faint, until its work is done
  // ---------------------------------------------------------------------------------------

  const outlineInk = new Color('#5f7183');
  const outlineAccent = new Color('#d97706');
  const outlines = plan.layers.flatMap((layer) => {
    if (layer.index === FOUNDATIONS) return [];
    const span = layerSpan(layer.index);
    const shape = new BoxGeometry(W, D, span.height);
    const fill = new Mesh(shape, own(new MeshBasicMaterial({ color: '#a9bccd', transparent: true, opacity: 0, depthWrite: false })));
    const lines = new LineSegments(new EdgesGeometry(shape), own(new LineBasicMaterial({ color: outlineInk.clone(), transparent: true, opacity: 0, depthWrite: false })));
    const group = new Group();
    group.name = `${layer.name} outline`;
    group.add(fill, lines);
    group.position.set((X0 + X1) / 2, (Y0 + Y1) / 2, span.z + span.height / 2);
    group.visible = false;
    layerGroups[layer.index]!.add(group);
    // The rows that build this story: its own, and those that go up every story (the steel, the glass).
    const parts = plan.parts.filter((part) => part.layer === layer.index || (part.layer === -1 && part.kind !== 'clean' && part.kind !== 'handover' && layer.index > 0 && layer.index <= stories));
    return [{ index: layer.index, group, fill, lines, parts }];
  });
  let outlined: number | null = null;

  /** The crane where it stands, jib and all, while it is up on the date on show (by its rental, not the last frame). */
  function craneBox(): Box3 | null {
    if (!crane) return null;
    const span = steel ? dateNow >= steel.task.start && dateNow < steel.task.end : false;
    const up = craneBooking ? machineOn(craneBooking, dateNow).booked : span;
    if (!up) return null;
    crane.root.updateWorldMatrix(true, true);
    const wasShown = crane.root.visible;
    crane.root.visible = true;
    const box = new Box3().setFromObject(crane.root);
    crane.root.visible = wasShown;
    return box;
  }

  function drawOutlines(): void {
    for (const outline of outlines) {
      const built = outline.parts.map((part) => Math.min(1, builtBy(part.task, dateNow)));
      const left = built.length ? 1 - built.reduce((sum, value) => sum + value, 0) / built.length : 0;
      const accent = outline.index === outlined;
      outline.group.visible = left > 0.001;
      const lines = outline.lines.material as LineBasicMaterial;
      lines.color.copy(accent ? outlineAccent : outlineInk);
      lines.opacity = accent ? 0.95 : 0.22 + 0.33 * left;
      (outline.fill.material as MeshBasicMaterial).opacity = accent ? 0.14 : 0.05 * left;
    }
  }

  // ---------------------------------------------------------------------------------------
  // The interface
  // ---------------------------------------------------------------------------------------

  const ray = { hits: [] as { object: Object3D; distance: number }[] };
  const pickable = () => pieces.flatMap((piece) => piece.objects).filter((object) => object.visible && isShown(object));
  function isShown(object: Object3D): boolean {
    for (let at: Object3D | null = object; at; at = at.parent) if (!at.visible) return false;
    return true;
  }

  function layerSpan(index: number) {
    if (index === FOUNDATIONS) return { z: -DIG.depth, height: DIG.depth };
    if (index === roof) return { z: floorTop(stories), height: 30 };
    return { z: floorTop(storyOf(index)), height: STORY };
  }

  return {
    root,
    site,
    plan,
    layerSpan,
    setDate,
    setOffsets(next) {
      next.forEach((offset, index) => {
        offsets[index] = offset;
        const group = layerGroups[index];
        if (group) group.position.z = offset;
      });
    },
    offsetOf: (index) => offsets[index] ?? 0,
    setCutaway(amount) {
      const keep = 1 - amount;
      cutaway = amount;
      look.glassNear.opacity = 0.32 * keep;
      look.frameNear.opacity = keep;
      look.spandrelNear.opacity = keep;
      for (const material of cutawayMaterials) {
        material.depthWrite = material !== look.glassNear && keep > 0.98;
        // Hidden by its material, so a near panel still lands when its day comes and the cutaway closes over it.
        material.visible = keep > 0.02;
      }
      setPaint(rule);
    },
    setPaint,
    setOutline(index) {
      outlined = index;
      drawOutlines();
    },
    siteBounds(target, withCrane = true) {
      target.set(new Vector3(X0, Y0, -DIG.depth), new Vector3(X1, Y1, floorTop(stories) + 30));
      const up = withCrane ? craneBox() : null;
      if (up) target.union(up);
      return target;
    },
    craneBounds(target) {
      const up = craneBox();
      return up ? target.copy(up) : null;
    },
    craneHook(target) {
      // The crane reports its hook in the scene's own space already.
      return crane && crane.root.visible ? crane.hookAt(target) : null;
    },
    craneBase(target) {
      root.updateWorldMatrix(true, false);
      return root.localToWorld(target.set(CRANE_AT.x, CRANE_AT.y, 0));
    },
    craneJib() {
      return crane ? { height: crane.height, reach: crane.jib } : null;
    },
    holdCrane(over) {
      holding = over !== null;
      // Let go, it swings back from where it was held.
      if (over) heldOver = { ...craneAim(over.x, over.y), hookZ: over.hookZ };
    },
    lightLayers: () => floorLights.map((light) => light.layer),
    setFloorLights(on) {
      lightsHeld = on;
    },
    builtTop() {
      let top = 0;
      for (const piece of pieces) {
        if (piece.box.isEmpty() || within(builtBy(piece.task, dateNow), piece.range[0], piece.range[1]) <= 0) continue;
        top = Math.max(top, piece.box.max.z + (offsets[piece.layer] ?? 0));
      }
      return top;
    },
    pick(raycaster) {
      ray.hits = raycaster.intersectObjects(pickable(), false);
      const hit = ray.hits.find((entry) => (entry.object.userData.base as Material | undefined) !== look.glassNear || (look.glassNear.opacity > 0.1));
      if (!hit) return null;
      return { taskId: hit.object.userData.taskId as number, layer: hit.object.userData.layer as number };
    },
    boundsOf(taskId, target) {
      const list = byTask.get(taskId);
      if (!list || list.length === 0) return null;
      target.makeEmpty();
      for (const piece of list) {
        if (piece.box.isEmpty()) continue;
        const moved = piece.box.clone();
        moved.min.z += offsets[piece.layer] ?? 0;
        moved.max.z += offsets[piece.layer] ?? 0;
        target.union(moved);
      }
      return target.isEmpty() ? null : target;
    },
    layerCenter(index, target) {
      const span = layerSpan(index);
      return target.set(0, 0, span.z + span.height / 2 + (offsets[index] ?? 0));
    },
    update,
    dispose() {
      for (const crew of crews.values()) for (const worker of crew) worker.root.removeFromParent();
      site.dispose();
      root.traverse((object) => (object as Mesh).geometry?.dispose());
      for (const material of owned) {
        (material as MeshStandardMaterial).map?.dispose();
        material.dispose();
      }
      root.removeFromParent();
    },
  };
}

/** The real excavator (props.ts), with its arm posed in code; null if it did not load. */
function realExcavatorOf(props: PropKit | null): { root: Group; pose(yaw: number, boom: number, stick: number, bucket: number): void } | null {
  const model = props?.raw('excavator');
  const [upper, boom, arm, bucket] = ['upper', 'boom', 'arm', 'bucket'].map((part) => model?.getObjectByName(`excavator_${part}`));
  if (!model || !upper || !boom || !arm || !bucket) return null;
  const root = new Group();
  const turned = new Group();
  turned.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)));
  turned.scale.setScalar(13);
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
      boom.rotation.x = 0.35 - boomAngle;
      arm.rotation.x = -stickAngle - 1.63;
      bucket.rotation.x = -bucketAngle - 0.2;
    },
  };
}
