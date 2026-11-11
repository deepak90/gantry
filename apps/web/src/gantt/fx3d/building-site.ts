/**
 * The lot the building stands on, as on an architect's model: a base with its two streets, sidewalks, street trees and
 * the neighbors drawn as plain blocks, so the building reads at its real size. Around the work while it lasts: the
 * site fence and its gate, the site office, the dig and its spoil, and the lay-down where materials wait. From the
 * handover on, the fence and the cabins are gone and the lot is a plaza.
 *
 * The footprint is a hole in the ground with fill in it: the dig takes the fill down, the backfill brings it back, and
 * it can be shown see-through, so the footings below the ground can be looked at.
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeShapes as mergeGeometries } from './machines';

/** The building's footprint, centered on the origin. */
export const FOOTPRINT = { x0: -150, x1: 150, y0: -100, y1: 100 } as const;
/** The hole the footings go in: the footprint and a working margin. */
export const DIG = { x0: -164, x1: 164, y0: -114, y1: 114, depth: 18 } as const;
export const LOT = { x0: -300, x1: 236, y0: -176, y1: 196 } as const;
const BASE = { x0: -420, x1: 450, y0: -410, y1: 340, thick: 26 } as const;
/** The base's footprint, its middle, and its bottom, which stands on whatever the site is put on. */
export const BASE_SIZE = { w: BASE.x1 - BASE.x0, d: BASE.y1 - BASE.y0 } as const;
export const BASE_CENTER = { x: (BASE.x0 + BASE.x1) / 2, y: (BASE.y0 + BASE.y1) / 2 } as const;
export const BASE_BOTTOM = -(DIG.depth + 4) - BASE.thick;
const STREET_FRONT = { y0: -292, y1: -204 } as const;
const STREET_SIDE = { x0: 262, x1: 340 } as const;
const WALK = 28;
/** Where the gate is in the front fence, and the site office beside it. */
export const GATE = { x0: -262, x1: -206 } as const;
/** Where the pump and the mixer stand on the street during a pour. */
export const PUMP_AT = { x: -10, y: -238 } as const;
export const MIXER_AT = { x: -168, y: -240 } as const;
export const CRANE_AT = { x: -214, y: 64 } as const;
export const LAYDOWN = { x: -232, y: -128 } as const;
/** The neighbors, x0, y0, x1, y1, height and tone: tall behind the site, low beside it, nothing between it and the street. */
export const NEIGHBORS: readonly (readonly [number, number, number, number, number, string])[] = [
  [-400, 222, -160, 326, 150, '#f1f0ec'],
  [-140, 232, 70, 326, 196, '#f3f2ee'],
  [92, 222, 236, 326, 112, '#efeeea'],
  [-408, -140, -330, 196, 44, '#f2f1ed'],
  [370, -190, 446, 10, 70, '#f0efeb'],
  [370, 34, 446, 326, 128, '#f2f1ed'],
];

/**
 * How far a camera going round the site from high up leans from straight down (rig.ts), by the side it is on (its
 * azimuth: 0 over the street in front, pi behind the site): lowest over the street, where nothing stands between, and
 * highest over the tall neighbors behind, so none of them ever hides the building's foot. From behind, with the site
 * held left of a side panel, the footprint stays in sight up to a lean of about 0.6; from the sides and the front, to
 * beyond 0.85.
 */
export const flyLean = (azimuth: number): number => 0.73 + 0.16 * Math.cos(azimuth);

export interface SiteModel {
  root: Group;
  /** How deep the fill in the footprint is dug, from 0 (at grade) to 1 (all the way). */
  setDig(depth: number): void;
  /** The spoil heap beside the dig, from nothing to its full size. */
  setSpoil(size: number): void;
  /** The fill shown see-through, from 0 (solid) to 1 (all but gone), to look at what is under the ground. */
  setReveal(amount: number): void;
  /** The fence, the cabins and the sign: there while the work is (from mobilizing to the handover). */
  setWorks(shown: number): void;
  /** The plaza and the planting around the finished building. */
  setFinished(shown: number): void;
  dispose(): void;
}

function noisy(base: string, spread: number, size = 256, repeat = 1): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = base;
  paint.fillRect(0, 0, size, size);
  const image = paint.getImageData(0, 0, size, size);
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let index = 0; index < image.data.length; index += 4) {
    const grain = (random() - 0.5) * spread;
    image.data[index] = Math.max(0, Math.min(255, image.data[index]! + grain));
    image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1]! + grain));
    image.data[index + 2] = Math.max(0, Math.min(255, image.data[index + 2]! + grain));
  }
  paint.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  return texture;
}

/** The base's top, painted once: streets with their markings and names, sidewalks with their joints, the lot. */
function groundTexture(): CanvasTexture {
  const scale = 2.4;
  const width = Math.round((BASE.x1 - BASE.x0) * scale);
  const height = Math.round((BASE.y1 - BASE.y0) * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const paint = canvas.getContext('2d')!;
  // Canvas y runs down; the site's y runs back, away from the street.
  const px = (x: number) => (x - BASE.x0) * scale;
  const py = (y: number) => (BASE.y1 - y) * scale;
  const rect = (x0: number, y0: number, x1: number, y1: number, color: string) => {
    paint.fillStyle = color;
    paint.fillRect(px(x0), py(y1), (x1 - x0) * scale, (y1 - y0) * scale);
  };
  // Everything that isn't street or lot is the neighbors' paving.
  rect(BASE.x0, BASE.y0, BASE.x1, BASE.y1, '#e9e8e3');
  // The streets.
  const asphalt = '#a9a8a4';
  rect(BASE.x0, STREET_FRONT.y0, BASE.x1, STREET_FRONT.y1, asphalt);
  rect(STREET_SIDE.x0, BASE.y0, STREET_SIDE.x1, BASE.y1, asphalt);
  // Sidewalks on both sides of each street, with their joints.
  const walk = '#f1f0ec';
  rect(BASE.x0, STREET_FRONT.y1, STREET_SIDE.x0, STREET_FRONT.y1 + WALK, walk);
  rect(BASE.x0, STREET_FRONT.y0 - WALK, BASE.x1, STREET_FRONT.y0, walk);
  rect(STREET_SIDE.x0 - WALK, STREET_FRONT.y1, STREET_SIDE.x0, BASE.y1, walk);
  rect(STREET_SIDE.x1, STREET_FRONT.y1, STREET_SIDE.x1 + WALK, BASE.y1, walk);
  paint.strokeStyle = 'rgba(120, 112, 100, 0.22)';
  paint.lineWidth = 1;
  for (let x = BASE.x0; x < STREET_SIDE.x0; x += 14) {
    paint.beginPath();
    paint.moveTo(px(x), py(STREET_FRONT.y1));
    paint.lineTo(px(x), py(STREET_FRONT.y1 + WALK));
    paint.stroke();
  }
  for (let y = STREET_FRONT.y1; y < BASE.y1; y += 14) {
    paint.beginPath();
    paint.moveTo(px(STREET_SIDE.x0 - WALK), py(y));
    paint.lineTo(px(STREET_SIDE.x0), py(y));
    paint.stroke();
  }
  // The lot: compacted ground, with a gravel drive from the gate.
  rect(LOT.x0, LOT.y0, LOT.x1, LOT.y1, '#d9d1c1');
  rect(GATE.x0, LOT.y0, GATE.x1, LOT.y0 + 120, '#cbc5b8');
  rect(GATE.x0, LOT.y0 + 60, -120, LOT.y0 + 120, '#cbc5b8');
  // Lane markings: a dashed center line, edge lines, parking bays and a crossing at the corner.
  paint.fillStyle = 'rgba(250, 248, 242, 0.92)';
  const midFront = (STREET_FRONT.y0 + STREET_FRONT.y1) / 2;
  for (let x = BASE.x0 + 10; x < STREET_SIDE.x0 - 30; x += 34) paint.fillRect(px(x), py(midFront) - 1.4, 18 * scale, 2.8);
  const midSide = (STREET_SIDE.x0 + STREET_SIDE.x1) / 2;
  for (let y = STREET_FRONT.y1 + 40; y < BASE.y1; y += 34) paint.fillRect(px(midSide) - 1.4, py(y + 18), 2.8, 18 * scale);
  for (let x = STREET_SIDE.x0 + 6; x < STREET_SIDE.x1 - 4; x += 9) paint.fillRect(px(x), py(STREET_FRONT.y1 - 2), 5 * scale, 24 * scale);
  for (let y = STREET_FRONT.y0 + 6; y < STREET_FRONT.y1 - 4; y += 9) paint.fillRect(px(STREET_SIDE.x0 - 26), py(y + 5), 24 * scale, 5 * scale);
  paint.fillStyle = 'rgba(250, 248, 242, 0.55)';
  for (let x = -360; x < 220; x += 42) paint.fillRect(px(x), py(STREET_FRONT.y1 - 4), 1.6, 16 * scale);
  // The street names, set like a map's: small, spaced capitals along the lane.
  paint.fillStyle = 'rgba(250, 248, 242, 0.8)';
  paint.textAlign = 'center';
  paint.textBaseline = 'middle';
  paint.font = `600 ${Math.round(9 * scale)}px Inter, "Helvetica Neue", Arial, sans-serif`;
  (paint as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.round(3.4 * scale)}px`;
  paint.fillText('HARBOR STREET', px(-90), py(midFront - 22));
  paint.save();
  paint.translate(px(midSide + 20), py(40));
  paint.rotate(-Math.PI / 2);
  paint.fillText('PIER AVENUE', 0, 0);
  paint.restore();
  // Tree pits along the sidewalks.
  paint.fillStyle = '#c7bca9';
  for (const x of TREES_FRONT) paint.fillRect(px(x - 6), py(STREET_FRONT.y1 + WALK / 2 + 6), 12 * scale, 12 * scale);
  for (const y of TREES_SIDE) paint.fillRect(px(STREET_SIDE.x0 - WALK / 2 - 6), py(y + 6), 12 * scale, 12 * scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 16;
  return texture;
}

// Street trees stop short of the lot's front, so the storefront and what lies on the lot can be seen from the street.
const TREES_FRONT = [-380, -316, 196];
const TREES_SIDE = [-150, -86, -22, 42, 106, 170, 234, 298];

/** A top with a hole in it: four rectangles around the dig, their texture mapped to the whole base. */
function topWithHole(): BufferGeometry[] {
  const pieces: [number, number, number, number][] = [
    [BASE.x0, BASE.y0, BASE.x1, DIG.y0],
    [BASE.x0, DIG.y1, BASE.x1, BASE.y1],
    [BASE.x0, DIG.y0, DIG.x0, DIG.y1],
    [DIG.x1, DIG.y0, BASE.x1, DIG.y1],
  ];
  return pieces.map(([x0, y0, x1, y1]) => {
    const geometry = new PlaneGeometry(x1 - x0, y1 - y0);
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    const uv = geometry.attributes.uv!;
    const position = geometry.attributes.position!;
    for (let index = 0; index < uv.count; index++) {
      uv.setXY(index, (position.getX(index) - BASE.x0) / (BASE.x1 - BASE.x0), (position.getY(index) - BASE.y0) / (BASE.y1 - BASE.y0));
    }
    return geometry;
  });
}

const matrix = new Matrix4();
const turn = new Quaternion();
const up = new Vector3(0, 0, 1);
const at = new Vector3();
const size = new Vector3();

export function createSite(): SiteModel {
  const root = new Group();
  const owned: Material[] = [];
  const own = <T extends Material>(material: T): T => {
    owned.push(material);
    return material;
  };

  // The base, its edge a shade darker, like a model's board.
  const baseMaterial = own(new MeshStandardMaterial({ color: '#d7d6d1', roughness: 0.9 }));
  const under = -(DIG.depth + 4);
  const block = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) => new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const base = new Mesh(
    mergeGeometries([
      block(BASE.x0, BASE.y0, BASE.x1, BASE.y1, under - BASE.thick, under),
      block(BASE.x0, BASE.y0, BASE.x1, DIG.y0 - 4, under, -0.4),
      block(BASE.x0, DIG.y1 + 4, BASE.x1, BASE.y1, under, -0.4),
      block(BASE.x0, DIG.y0 - 4, DIG.x0 - 4, DIG.y1 + 4, under, -0.4),
      block(DIG.x1 + 4, DIG.y0 - 4, BASE.x1, DIG.y1 + 4, under, -0.4),
    ]),
    baseMaterial,
  );
  base.receiveShadow = true;
  base.castShadow = true;
  root.add(base);
  const top = new Mesh(mergeGeometries(topWithHole()), own(new MeshStandardMaterial({ map: groundTexture(), roughness: 0.94 })));
  top.receiveShadow = true;
  root.add(top);

  // Curbs: a crisp edge where each sidewalk meets the street.
  const curbMaterial = own(new MeshStandardMaterial({ color: '#d4cfc4', roughness: 0.85 }));
  const curb = (x0: number, y0: number, x1: number, y1: number) => {
    const geometry = new BoxGeometry(Math.max(1.6, x1 - x0), Math.max(1.6, y1 - y0), 1.4);
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, 0.7);
    return geometry;
  };
  const curbs = new Mesh(
    mergeGeometries([
      curb(BASE.x0, STREET_FRONT.y1 - 0.8, STREET_SIDE.x0 - 0.8, STREET_FRONT.y1 + 0.8),
      curb(BASE.x0, STREET_FRONT.y0 - 0.8, BASE.x1, STREET_FRONT.y0 + 0.8),
      curb(STREET_SIDE.x0 - 0.8, STREET_FRONT.y1, STREET_SIDE.x0 + 0.8, BASE.y1),
      curb(STREET_SIDE.x1 - 0.8, STREET_FRONT.y1, STREET_SIDE.x1 + 0.8, BASE.y1),
    ]),
    curbMaterial,
  );
  curbs.receiveShadow = true;
  root.add(curbs);

  // The dig: its four earth walls, and the fill that is taken out and put back.
  const earth = own(new MeshStandardMaterial({ map: noisy('#a88a63', 30, 256, 6), roughness: 1 }));
  const fillMaterial = own(new MeshStandardMaterial({ map: noisy('#d2c6b0', 22, 256, 5), roughness: 1, transparent: true, opacity: 1 }));
  const settled = new Color('#ffffff');
  const freshDug = new Color('#c4ae8c');
  const pitWalls = new Group();
  const wall = (w: number, d: number, x: number, y: number) => {
    const mesh = new Mesh(new BoxGeometry(w, d, DIG.depth + 4), earth);
    mesh.position.set(x, y, -(DIG.depth + 4) / 2);
    mesh.receiveShadow = true;
    pitWalls.add(mesh);
  };
  wall(DIG.x1 - DIG.x0 + 8, 4, 0, DIG.y0 - 2);
  wall(DIG.x1 - DIG.x0 + 8, 4, 0, DIG.y1 + 2);
  wall(4, DIG.y1 - DIG.y0, DIG.x0 - 2, 0);
  wall(4, DIG.y1 - DIG.y0, DIG.x1 + 2, 0);
  root.add(pitWalls);
  const pitFloor = new Mesh(new PlaneGeometry(DIG.x1 - DIG.x0, DIG.y1 - DIG.y0), earth);
  pitFloor.position.z = -DIG.depth;
  pitFloor.receiveShadow = true;
  root.add(pitFloor);
  const fill = new Mesh(new BoxGeometry(DIG.x1 - DIG.x0, DIG.y1 - DIG.y0, DIG.depth), fillMaterial);
  fill.receiveShadow = true;
  fill.renderOrder = 1;
  root.add(fill);
  const spoil = new Mesh(new IcosahedronGeometry(1, 2), earth);
  spoil.position.set(196, -138, 0);
  spoil.castShadow = true;
  spoil.receiveShadow = true;
  root.add(spoil);

  // Street trees, as a model maker makes them: a plain stem and a faceted crown in soft greens.
  const crownGeometry = new IcosahedronGeometry(1, 1);
  const crownMaterial = own(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, flatShading: true }));
  const trunkMaterial = own(new MeshStandardMaterial({ color: '#7c7266', roughness: 0.9 }));
  const treeSpots: [number, number, number][] = [
    ...TREES_FRONT.map((x, index) => [x, STREET_FRONT.y1 + WALK / 2, index] as [number, number, number]),
    ...TREES_SIDE.map((y, index) => [STREET_SIDE.x0 - WALK / 2, y, index + 20] as [number, number, number]),
    ...[-380, -300, -190, -60, 70, 200, 330, 420].map((x, index) => [x, STREET_FRONT.y0 - WALK / 2, index + 40] as [number, number, number]),
    ...[-300, -200, -100, 0, 100, 200, 300].map((y, index) => [STREET_SIDE.x1 + WALK / 2, y, index + 60] as [number, number, number]),
  ];
  const crowns = new InstancedMesh(crownGeometry, crownMaterial, treeSpots.length);
  const trunks = new InstancedMesh(new CylinderGeometry(1.2, 1.6, 1, 8).rotateX(Math.PI / 2).translate(0, 0, 0.5), trunkMaterial, treeSpots.length);
  const greens = ['#a9bc9b', '#9db293', '#b4c3a5', '#97ab8e', '#aebf9f'].map((value) => new Color(value));
  treeSpots.forEach(([x, y, seed], index) => {
    const scale = 13 + ((seed * 37) % 7);
    const stem = 15 + ((seed * 13) % 5);
    matrix.compose(at.set(x, y, stem + scale * 0.7), turn.setFromAxisAngle(up, seed * 1.3), size.set(scale, scale, scale * 1.08));
    crowns.setMatrixAt(index, matrix);
    crowns.setColorAt(index, greens[seed % greens.length]!);
    matrix.compose(at.set(x, y, 0), turn.identity(), size.set(1, 1, stem + scale * 0.3));
    trunks.setMatrixAt(index, matrix);
  });
  crowns.castShadow = true;
  crowns.receiveShadow = true;
  trunks.castShadow = true;
  root.add(crowns, trunks);

  // Street lights: a slim pole and an arm over the curb.
  const poleMaterial = own(new MeshStandardMaterial({ color: '#5a5f64', roughness: 0.5, metalness: 0.5 }));
  const poleGeometry = mergeGeometries([
    new CylinderGeometry(0.7, 0.9, 30, 8).rotateX(Math.PI / 2).translate(0, 0, 15),
    new BoxGeometry(1, 9, 0.9).translate(0, -4.2, 29.5),
    new BoxGeometry(3.2, 5, 1.4).translate(0, -8.4, 29),
  ]);
  const poleSpots: [number, number, number][] = [
    ...[-350, -190, -30, 130].map((x) => [x, STREET_FRONT.y1 + 4, 0] as [number, number, number]),
    ...[-120, 40, 200].map((y) => [STREET_SIDE.x0 - 4, y, Math.PI / 2] as [number, number, number]),
  ];
  const poles = new InstancedMesh(poleGeometry, poleMaterial, poleSpots.length);
  poleSpots.forEach(([x, y, angle], index) => poles.setMatrixAt(index, matrix.compose(at.set(x, y, 0), turn.setFromAxisAngle(up, angle), size.set(1, 1, 1))));
  poles.castShadow = true;
  root.add(poles);

  // The neighbors: plain blocks with a faint grid of windows, lower toward the camera.
  const facade = (floors: number, bays: number, tone: string): CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const paint = canvas.getContext('2d')!;
    paint.fillStyle = tone;
    paint.fillRect(0, 0, 256, 256);
    paint.fillStyle = 'rgba(96, 108, 120, 0.11)';
    const cellW = 256 / bays;
    const cellH = 256 / floors;
    for (let row = 0; row < floors; row++) for (let col = 0; col < bays; col++) paint.fillRect(col * cellW + cellW * 0.18, row * cellH + cellH * 0.22, cellW * 0.64, cellH * 0.5);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  };
  for (const [x0, y0, x1, y1, height, tone] of NEIGHBORS) {
    const sideMaterial = own(new MeshStandardMaterial({ map: facade(Math.max(1, Math.round(height / 42)), Math.max(2, Math.round(Math.max(x1 - x0, y1 - y0) / 34)), tone), roughness: 0.92 }));
    const roofMaterial = own(new MeshStandardMaterial({ color: tone, roughness: 0.95 }));
    const block = new Mesh(new BoxGeometry(x1 - x0, y1 - y0, height), [sideMaterial, sideMaterial, sideMaterial, sideMaterial, roofMaterial, roofMaterial]);
    block.position.set((x0 + x1) / 2, (y0 + y1) / 2, height / 2);
    block.castShadow = true;
    block.receiveShadow = true;
    root.add(block);
  }

  // ---- The works: fence, gate, cabins, sign ------------------------------------------------
  const works = new Group();
  root.add(works);
  const fenceHeight = 15;
  const meshCanvas = document.createElement('canvas');
  meshCanvas.width = 64;
  meshCanvas.height = 64;
  const meshPaint = meshCanvas.getContext('2d')!;
  meshPaint.strokeStyle = 'rgba(70, 76, 82, 0.9)';
  meshPaint.lineWidth = 2;
  for (let index = -64; index < 128; index += 16) {
    meshPaint.beginPath();
    meshPaint.moveTo(index, 0);
    meshPaint.lineTo(index + 64, 64);
    meshPaint.moveTo(index + 64, 0);
    meshPaint.lineTo(index, 64);
    meshPaint.stroke();
  }
  const meshTexture = new CanvasTexture(meshCanvas);
  meshTexture.wrapS = RepeatWrapping;
  meshTexture.wrapT = RepeatWrapping;
  const fenceMaterial = own(new MeshStandardMaterial({ map: meshTexture, transparent: true, alphaTest: 0.2, side: DoubleSide, roughness: 0.6, metalness: 0.4, color: '#7b8389' }));
  const screenMaterial = own(new MeshStandardMaterial({ color: '#3f5a4f', roughness: 0.9, side: DoubleSide }));
  const runs: [number, number, number, number][] = [
    [LOT.x0, LOT.y0, GATE.x0, LOT.y0],
    [GATE.x1, LOT.y0, LOT.x1, LOT.y0],
    [LOT.x1, LOT.y0, LOT.x1, LOT.y1],
    [LOT.x1, LOT.y1, LOT.x0, LOT.y1],
    [LOT.x0, LOT.y1, LOT.x0, LOT.y0],
  ];
  const postSpots: [number, number][] = [];
  for (const [x0, y0, x1, y1] of runs) {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const panel = new Mesh(new PlaneGeometry(length, fenceHeight), fenceMaterial);
    panel.rotation.x = Math.PI / 2;
    panel.rotation.y = Math.atan2(y1 - y0, x1 - x0);
    panel.position.set((x0 + x1) / 2, (y0 + y1) / 2, fenceHeight / 2 + 1);
    (panel.material as MeshStandardMaterial).map!.repeat.set(length / 6, fenceHeight / 6);
    works.add(panel);
    // A dark screen along the street side only, like a hoarding.
    if (y0 === LOT.y0 && y1 === LOT.y0) {
      const screen = new Mesh(new PlaneGeometry(length, fenceHeight * 0.62), screenMaterial);
      screen.rotation.x = Math.PI / 2;
      screen.position.set((x0 + x1) / 2, y0 - 0.4, fenceHeight * 0.31 + 1);
      screen.receiveShadow = true;
      works.add(screen);
    }
    const count = Math.max(1, Math.round(length / 24));
    for (let index = 0; index <= count; index++) postSpots.push([x0 + ((x1 - x0) * index) / count, y0 + ((y1 - y0) * index) / count]);
  }
  const posts = new InstancedMesh(mergeGeometries([new BoxGeometry(1, 1, fenceHeight + 1).translate(0, 0, (fenceHeight + 1) / 2), new BoxGeometry(6, 2.6, 1.6).translate(0, 0, 0.8)]), own(new MeshStandardMaterial({ color: '#8b9196', roughness: 0.5, metalness: 0.4 })), postSpots.length);
  postSpots.forEach(([x, y], index) => posts.setMatrixAt(index, matrix.compose(at.set(x, y, 0), turn.identity(), size.set(1, 1, 1))));
  posts.castShadow = true;
  works.add(posts);

  // The site office by the gate, the toilets and a skip.
  const cabin = (w: number, d: number, h: number, color: string, x: number, y: number, angle = 0) => {
    const group = new Group();
    const body = new Mesh(new RoundedBoxGeometry(w, d, h, 2, 1), own(new MeshStandardMaterial({ color, roughness: 0.62 })));
    body.position.z = h / 2 + 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    group.position.set(x, y, 0);
    group.rotation.z = angle;
    works.add(group);
    return group;
  };
  const office = cabin(78, 26, 24, '#eceae4', -248, -96, 0);
  const windows = new Mesh(mergeGeometries([-24, -6, 12].map((x) => new BoxGeometry(12, 0.6, 8).translate(x, -13.2, 17))), own(new MeshStandardMaterial({ color: '#34444f', roughness: 0.1, metalness: 0.6 })));
  office.add(windows);
  office.add(new Mesh(new BoxGeometry(8, 0.6, 16).translate(26, -13.2, 11), own(new MeshStandardMaterial({ color: '#5d6a74', roughness: 0.5 }))));
  const stacked = cabin(78, 26, 22, '#e4e2dc', -248, -96, 0);
  stacked.position.z = 26;
  cabin(9, 9, 22, '#4c6d87', -286, -40);
  cabin(9, 9, 22, '#4c6d87', -286, -28);
  const skip = new Group();
  const skipMaterial = own(new MeshStandardMaterial({ color: '#4a6b5d', roughness: 0.6, metalness: 0.3 }));
  const skipShape = mergeGeometries([new BoxGeometry(44, 20, 2).translate(0, 0, 1), new BoxGeometry(44, 2, 14).translate(0, -9, 8), new BoxGeometry(44, 2, 14).translate(0, 9, 8), new BoxGeometry(2, 20, 14).translate(-21, 0, 8), new BoxGeometry(2, 20, 11).translate(21, 0, 6.5)]);
  const skipMesh = new Mesh(skipShape, skipMaterial);
  skipMesh.castShadow = true;
  skip.add(skipMesh);
  skip.position.set(196, 150, 0);
  works.add(skip);

  // The project sign at the gate.
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 1024;
  signCanvas.height = 512;
  const signPaint = signCanvas.getContext('2d')!;
  signPaint.fillStyle = '#f7f6f2';
  signPaint.fillRect(0, 0, 1024, 512);
  signPaint.fillStyle = '#1f2a33';
  signPaint.fillRect(0, 0, 1024, 18);
  signPaint.textAlign = 'left';
  signPaint.font = '600 34px Inter, "Helvetica Neue", Arial, sans-serif';
  signPaint.fillStyle = '#6b737a';
  (signPaint as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '6px';
  signPaint.fillText('NOW BUILDING', 64, 120);
  (signPaint as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  signPaint.font = '700 92px Inter, "Helvetica Neue", Arial, sans-serif';
  signPaint.fillStyle = '#1f2a33';
  signPaint.fillText('Harbor Street', 60, 236);
  signPaint.fillText('Offices', 60, 336);
  signPaint.font = '500 32px Inter, "Helvetica Neue", Arial, sans-serif';
  signPaint.fillStyle = '#6b737a';
  signPaint.fillText('Four floors of offices · opening summer 2027', 64, 432);
  const signTexture = new CanvasTexture(signCanvas);
  signTexture.colorSpace = SRGBColorSpace;
  signTexture.anisotropy = 8;
  const sign = new Group();
  const board = new Mesh(new BoxGeometry(44, 1.2, 22), [own(new MeshStandardMaterial({ color: '#d8d6d0' })), own(new MeshStandardMaterial({ color: '#d8d6d0' })), own(new MeshStandardMaterial({ map: signTexture, roughness: 0.7 })), own(new MeshStandardMaterial({ color: '#d8d6d0' })), own(new MeshStandardMaterial({ color: '#d8d6d0' })), own(new MeshStandardMaterial({ color: '#d8d6d0' }))]);
  board.position.z = 26;
  board.castShadow = true;
  sign.add(board);
  sign.add(new Mesh(mergeGeometries([new BoxGeometry(1.4, 1.4, 16).translate(-18, 0, 8), new BoxGeometry(1.4, 1.4, 16).translate(18, 0, 8)]), poleMaterial));
  sign.position.set(-176, LOT.y0 - 10, 0);
  works.add(sign);

  // ---- When it is finished: a plaza of pavers and two lawns where the works were ------------
  const finished = new Group();
  root.add(finished);
  const paverMaterial = own(new MeshStandardMaterial({ map: noisy('#e2ddd3', 10, 128, 18), roughness: 0.9, transparent: true, opacity: 0 }));
  const lawnMaterial = own(new MeshStandardMaterial({ map: noisy('#b9c7a3', 16, 128, 10), roughness: 1, transparent: true, opacity: 0 }));
  const plaza = new Mesh(new PlaneGeometry(LOT.x1 - LOT.x0, LOT.y1 - LOT.y0), paverMaterial);
  plaza.position.set((LOT.x0 + LOT.x1) / 2, (LOT.y0 + LOT.y1) / 2, 0.15);
  plaza.receiveShadow = true;
  finished.add(plaza);
  for (const [x0, y0, x1, y1] of [
    [LOT.x0 + 10, LOT.y0 + 10, -180, 186],
    [170, -160, LOT.x1 - 10, -116],
  ] as const) {
    const lawn = new Mesh(new PlaneGeometry(x1 - x0, y1 - y0), lawnMaterial);
    lawn.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.3);
    lawn.receiveShadow = true;
    finished.add(lawn);
  }
  const plazaTrees = new InstancedMesh(crownGeometry, crownMaterial, 5);
  const plazaTrunks = new InstancedMesh(trunks.geometry, trunkMaterial, 5);
  [
    [-260, 120],
    [-230, 40],
    [-262, -40],
    [200, -138],
    [-200, -146],
  ].forEach(([x, y], index) => {
    plazaTrees.setMatrixAt(index, matrix.compose(at.set(x!, y!, 24), turn.setFromAxisAngle(up, index), size.set(15, 15, 16)));
    plazaTrees.setColorAt(index, greens[(index + 2) % greens.length]!);
    plazaTrunks.setMatrixAt(index, matrix.compose(at.set(x!, y!, 0), turn.identity(), size.set(1, 1, 20)));
  });
  plazaTrees.castShadow = true;
  plazaTrunks.castShadow = true;
  finished.add(plazaTrees, plazaTrunks);
  finished.visible = false;

  let dug = -1;
  return {
    root,
    setDig(depth) {
      if (depth === dug) return;
      dug = depth;
      const top = -DIG.depth * depth;
      const height = Math.max(0.001, top + DIG.depth);
      fill.scale.z = height / DIG.depth;
      fill.position.z = -DIG.depth + height / 2;
      // Freshly dug ground is darker than the compacted lot around it.
      fillMaterial.color.copy(settled).lerp(freshDug, Math.min(1, depth * 3));
    },
    setSpoil(amount) {
      spoil.visible = amount > 0.01;
      spoil.scale.set(46 * amount + 0.01, 30 * amount + 0.01, 13 * amount + 0.01);
    },
    setReveal(amount) {
      fillMaterial.opacity = 1 - amount * 0.86;
      fillMaterial.depthWrite = amount < 0.05;
      pitWalls.visible = amount < 0.95;
    },
    setWorks(shown) {
      works.visible = shown > 0.5;
    },
    setFinished(shown) {
      finished.visible = shown > 0.01;
      paverMaterial.opacity = shown;
      lawnMaterial.opacity = shown;
      plazaTrees.visible = shown > 0.5;
      plazaTrunks.visible = shown > 0.5;
    },
    dispose() {
      root.traverse((object) => (object as Mesh).geometry?.dispose());
      for (const material of owned) {
        (material as MeshStandardMaterial).map?.dispose();
        material.dispose();
      }
      root.removeFromParent();
    },
  };
}
