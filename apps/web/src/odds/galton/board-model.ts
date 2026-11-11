/**
 * The board as a model, built in code from its layout so the bins always match the plan's dates: a pale back panel
 * in a frame on a plinth, steel pegs, pale dividers, the deadline's heavier glass, a closed hopper the marbles leave
 * from, a faint glass front, and a trapdoor under the bins over a drawer in the plinth. The marbles are one
 * InstancedMesh (a color and a matrix each). Units are the layout's: marble diameters, y up, marbles in the z = 0
 * plane between the back panel and the glass.
 *
 * For the runs stacked as a building (galton/tower.ts): the pegs shrink away and the dividers and the glass sink into
 * the floor to make room, and the tower gets its ground, a plate between floors, its roof, the deadline as a floor
 * line, and a bracket beside a band of it.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Shape,
  ExtrudeGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { MARBLE_RADIUS, type BoardLayout } from './board';
import { floorLine, floorPlates, type TowerLayout } from './tower';

export interface Palette {
  panel: Color;
  frame: Color;
  divider: Color;
  steel: Color;
  glass: Color;
  ink: Color;
  onTime: Color;
  late: Color;
}

/** The parts of a tower of runs on the board, each as far as it is shown. */
export interface TowerParts {
  tower: TowerLayout;
  /** The ground it stands on, from nothing (0) to full (1). */
  ground: number;
  /** Floor plates shown from the bottom up, the roof last: 0 to the tower's floors (a fraction grows the next one). */
  floors: number;
  /** The deadline as a floor line over the first `count` marbles, shown from 0 to 1; null when there is none. */
  line: { count: number; shown: number } | null;
  /** A bracket beside the marbles between two counts, shown from 0 to 1; null for none. */
  band: { from: number; to: number; shown: number } | null;
}

export interface BoardModel {
  readonly group: Group;
  readonly marbles: InstancedMesh;
  /** The box the model fills, in its own units. */
  readonly bounds: { left: number; right: number; bottom: number; top: number; back: number; front: number };
  /** Opens the trapdoor under the bins: 0 shut, 1 open. */
  setTrapdoor(open: number): void;
  /** The pegs, the dividers and the deadline's glass: standing (0), or folded away (1) for a tower to have the room. */
  setFolded(amount: number): void;
  /** A tower's ground, floor plates, floor line and bracket, as far as each is shown; null takes them all away. */
  setTower(parts: TowerParts | null): void;
  /** Where marbles that drop through the trapdoor are out of sight. */
  readonly drawerY: number;
  dispose(): void;
}

/** Half the depth of the space the marbles move in: between the back panel and the glass. */
export const PLAY_HALF_DEPTH = 0.8;
const RAIL = 2.6;
const PLINTH = 6.5;
const PLINTH_DEPTH = 3.6;
const PANEL = 1.1;

export function createBoardModel(layout: BoardLayout, palette: Palette, capacity: number): BoardModel {
  const group = new Group();
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <G extends BufferGeometry>(geometry: G): G => {
    geometries.push(geometry);
    return geometry;
  };
  const own = <M extends Material>(material: M): M => {
    materials.push(material);
    return material;
  };

  const panelMaterial = own(new MeshStandardMaterial({ color: palette.panel, roughness: 0.9, metalness: 0 }));
  const frameMaterial = own(new MeshStandardMaterial({ color: palette.frame, roughness: 0.78, metalness: 0 }));
  const dividerMaterial = own(new MeshStandardMaterial({ color: palette.divider, roughness: 0.82, metalness: 0 }));
  const steelMaterial = own(new MeshStandardMaterial({ color: palette.steel, roughness: 0.3, metalness: 1 }));
  const drawerMaterial = own(new MeshStandardMaterial({ color: palette.frame.clone().multiplyScalar(0.42), roughness: 1, metalness: 0 }));

  const { left, right, top } = layout;
  const outerLeft = left - RAIL;
  const outerRight = right + RAIL;
  const width = outerRight - outerLeft;
  const add = (mesh: Mesh, cast = true, receive = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    group.add(mesh);
    return mesh;
  };

  // The back panel: its face is where the pegs' and marbles' shadows fall.
  const panel = add(new Mesh(keep(new RoundedBoxGeometry(width, top + RAIL, PANEL, 2, 0.35)), panelMaterial));
  panel.position.set((outerLeft + outerRight) / 2, (top + RAIL) / 2, -PLAY_HALF_DEPTH - PANEL / 2);

  // The frame: two posts and a top rail, standing a little proud of the glass.
  const frameDepth = PLAY_HALF_DEPTH * 2 + PANEL + 0.7;
  const frameZ = -PLAY_HALF_DEPTH - PANEL + frameDepth / 2;
  for (const x of [outerLeft + RAIL / 2, outerRight - RAIL / 2]) {
    const post = add(new Mesh(keep(new RoundedBoxGeometry(RAIL, top + RAIL, frameDepth, 2, 0.4)), frameMaterial));
    post.position.set(x, (top + RAIL) / 2, frameZ);
  }
  const rail = add(new Mesh(keep(new RoundedBoxGeometry(width, RAIL, frameDepth, 2, 0.4)), frameMaterial));
  rail.position.set((outerLeft + outerRight) / 2, top + RAIL / 2, frameZ);

  // The plinth, in three parts around a drawer under the bins: the trapdoor drops the marbles into it.
  const plinthLeft = outerLeft - 1.4;
  const plinthRight = outerRight + 1.4;
  const plinthWidth = plinthRight - plinthLeft;
  const front = add(new Mesh(keep(new RoundedBoxGeometry(plinthWidth, PLINTH, PLINTH_DEPTH - PLAY_HALF_DEPTH, 2, 0.45)), frameMaterial));
  front.position.set((plinthLeft + plinthRight) / 2, -PLINTH / 2, PLAY_HALF_DEPTH + (PLINTH_DEPTH - PLAY_HALF_DEPTH) / 2);
  const back = add(new Mesh(keep(new RoundedBoxGeometry(plinthWidth, PLINTH, PLINTH_DEPTH - PLAY_HALF_DEPTH, 2, 0.45)), frameMaterial));
  back.position.set((plinthLeft + plinthRight) / 2, -PLINTH / 2, -PLAY_HALF_DEPTH - (PLINTH_DEPTH - PLAY_HALF_DEPTH) / 2);
  for (const [from, to] of [
    [plinthLeft, left],
    [right, plinthRight],
  ] as const) {
    const end = add(new Mesh(keep(new BoxGeometry(to - from, PLINTH, PLAY_HALF_DEPTH * 2)), frameMaterial));
    end.position.set((from + to) / 2, -PLINTH / 2, 0);
  }
  const drawer = add(new Mesh(keep(new BoxGeometry(right - left, 0.4, PLAY_HALF_DEPTH * 2)), drawerMaterial), false, true);
  drawer.position.set((left + right) / 2, -PLINTH + 0.6, 0);

  // A soft shadow where the plinth meets the paper (no long cast shadow: a studio's soft key and a big fill).
  const shadowTexture = contactShadowTexture();
  const contact = new Mesh(
    keep(new PlaneGeometry(plinthWidth * 1.1, PLINTH_DEPTH * 4.2)),
    own(new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.34, alphaMap: shadowTexture, depthWrite: false })),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.set((plinthLeft + plinthRight) / 2, -PLINTH + 0.02, 0.4);
  contact.renderOrder = -1;
  group.add(contact);

  // The trapdoor: hinged along its back edge, so its front edge swings down.
  const hinge = new Object3D();
  hinge.position.set(0, 0, -PLAY_HALF_DEPTH);
  const flap = new Mesh(keep(new BoxGeometry(right - left, 0.4, PLAY_HALF_DEPTH * 2)), frameMaterial);
  flap.position.set((left + right) / 2, -0.2, PLAY_HALF_DEPTH);
  flap.receiveShadow = true;
  hinge.add(flap);
  group.add(hinge);

  // Dividers, and the deadline's heavier glass.
  const dividerGeometry = keep(new BoxGeometry(1, 1, PLAY_HALF_DEPTH * 2));
  /** What stands up from the floor and folds down into it for a tower: the dividers and the deadline's glass. */
  const standing: Object3D[] = [];
  for (const divider of layout.dividers) {
    if (divider.kind === 'side') continue;
    if (divider.kind === 'deadline') continue;
    const mesh = add(new Mesh(dividerGeometry, dividerMaterial));
    mesh.scale.set(divider.thickness, divider.top, 1);
    mesh.position.set(divider.x, divider.top / 2, 0);
    standing.push(mesh);
  }
  if (layout.deadline) {
    const { deadline } = layout;
    const glassMaterial = own(
      new MeshPhysicalMaterial({ color: palette.glass, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.62, clearcoat: 1, clearcoatRoughness: 0.08, depthWrite: false }),
    );
    // A plate of glass set into the board, standing proud of its front so it reads as one from the side.
    const proud = 1.6;
    const glassGeometry = keep(new BoxGeometry(deadline.thickness, deadline.top, PLAY_HALF_DEPTH * 2 + proud));
    const glass = new Mesh(glassGeometry, glassMaterial);
    glass.position.set(deadline.x, deadline.top / 2, proud / 2);
    glass.renderOrder = 2;
    group.add(glass);
    const edges = new LineSegments(keep(new EdgesGeometry(glassGeometry)), own(new LineBasicMaterial({ color: palette.ink, transparent: true, opacity: 0.55 })));
    edges.position.copy(glass.position);
    edges.renderOrder = 3;
    group.add(edges);
    // Its geometry is as tall as the glass: it folds by its scale.
    standing.push(glass, edges);
  }

  // Pegs: steel pins from the back panel to the glass.
  const pegCount = layout.pegs.length / 2;
  const pegGeometry = keep(new CylinderGeometry(layout.shape.pegRadius, layout.shape.pegRadius, PLAY_HALF_DEPTH * 2, 22, 1));
  pegGeometry.rotateX(Math.PI / 2);
  const pegs = new InstancedMesh(pegGeometry, steelMaterial, pegCount);
  const matrix = new Matrix4();
  for (let i = 0; i < pegCount; i += 1) {
    matrix.makeTranslation(layout.pegs[i * 2]!, layout.pegs[i * 2 + 1]!, 0);
    pegs.setMatrixAt(i, matrix);
  }
  pegs.castShadow = true;
  pegs.receiveShadow = true;
  group.add(pegs);

  // The hopper: a closed funnel the marbles leave from, its mouth over the middle of the board.
  const { hopper } = layout;
  const rise = Math.cos(hopper.slope) * hopper.wallLength;
  const spread = Math.sin(hopper.slope) * hopper.wallLength;
  const hopperTop = top;
  const outline = new Shape();
  const mouth = hopper.exit / 2;
  const wall = 0.6;
  outline.moveTo(hopper.center - mouth - wall, hopper.y);
  outline.lineTo(hopper.center + mouth + wall, hopper.y);
  outline.lineTo(hopper.center + mouth + wall + spread * ((hopperTop - hopper.y) / rise), hopperTop);
  outline.lineTo(hopper.center - mouth - wall - spread * ((hopperTop - hopper.y) / rise), hopperTop);
  outline.closePath();
  const hopperGeometry = keep(new ExtrudeGeometry(outline, { depth: PLAY_HALF_DEPTH * 2 + 0.3, bevelEnabled: true, bevelThickness: 0.18, bevelSize: 0.18, bevelSegments: 2 }));
  hopperGeometry.translate(0, 0, -PLAY_HALF_DEPTH - 0.15);
  add(new Mesh(hopperGeometry, frameMaterial));

  // The glass front: barely there, a sheen over the board.
  const glassFront = new Mesh(
    keep(new PlaneGeometry(right - left, top)),
    own(new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false })),
  );
  glassFront.position.set((left + right) / 2, top / 2, PLAY_HALF_DEPTH + 0.05);
  glassFront.renderOrder = 4;
  group.add(glassFront);

  // The marbles: satin, a color each.
  const marbleMaterial = own(new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.34, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.32 }));
  const marbles = new InstancedMesh(keep(new SphereGeometry(MARBLE_RADIUS, 28, 18)), marbleMaterial, Math.max(1, capacity));
  marbles.instanceMatrix.setUsage(DynamicDrawUsage);
  marbles.setColorAt(0, palette.onTime);
  marbles.instanceColor!.setUsage(DynamicDrawUsage);
  marbles.count = 0;
  marbles.castShadow = true;
  marbles.receiveShadow = true;
  marbles.frustumCulled = false;
  group.add(marbles);

  // ---- Folded away for a tower: the pegs shrink into nothing, the dividers and the glass sink into the floor ----
  const pegMatrix = new Matrix4();
  const pegScale = new Vector3();
  const pegAt = new Vector3();
  const standingHeights = standing.map((mesh) => ({ mesh, fullY: mesh.scale.y, fullPosition: mesh.position.y }));
  let folded = 0;
  function setFolded(amount: number): void {
    const next = Math.min(1, Math.max(0, amount));
    if (next === folded) return;
    folded = next;
    const k = Math.max(0.001, 1 - next);
    for (let i = 0; i < pegCount; i += 1) {
      pegAt.set(layout.pegs[i * 2]!, layout.pegs[i * 2 + 1]!, 0);
      pegs.setMatrixAt(i, pegMatrix.compose(pegAt, IDENTITY, pegScale.setScalar(k)));
    }
    pegs.instanceMatrix.needsUpdate = true;
    pegs.visible = next < 0.999;
    for (const entry of standingHeights) {
      entry.mesh.scale.y = entry.fullY * k;
      entry.mesh.position.y = entry.fullPosition * k;
      entry.mesh.visible = next < 0.999;
    }
  }

  // ---- A tower of runs: its ground, a plate between floors, its roof, the deadline's floor line, a bracket ----------
  const unit = keep(new BoxGeometry(1, 1, 1));
  const plateMaterial = own(new MeshStandardMaterial({ color: palette.frame.clone().multiplyScalar(0.84), roughness: 0.8, metalness: 0 }));
  const lineMaterial = own(new MeshBasicMaterial({ color: palette.ink, transparent: true, opacity: 1, depthWrite: false }));
  const bracketMaterial = own(new MeshBasicMaterial({ color: palette.ink, transparent: true, opacity: 0.7, depthWrite: false }));
  const towerGroup = new Group();
  towerGroup.visible = false;
  group.add(towerGroup);
  const towerGround = new Mesh(unit, frameMaterial);
  towerGround.castShadow = true;
  towerGround.receiveShadow = true;
  towerGroup.add(towerGround);
  const plates: Mesh[] = [];
  const lineParts = [0, 1, 2].map(() => {
    const mesh = new Mesh(unit, lineMaterial);
    mesh.renderOrder = 5;
    towerGroup.add(mesh);
    return mesh;
  });
  const bracketParts = [0, 1, 2].map(() => {
    const mesh = new Mesh(unit, bracketMaterial);
    mesh.renderOrder = 5;
    towerGroup.add(mesh);
    return mesh;
  });
  /** In front of the marbles, just over the glass front: the lines read as drawn on it. */
  const FRONT_Z = PLAY_HALF_DEPTH + 0.12;
  const LINE = 0.34;
  /** A bar from (x1, y1) to (x2, y2), level or upright, `thick` across. */
  const bar = (mesh: Mesh, x1: number, y1: number, x2: number, y2: number, thick: number) => {
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, FRONT_Z);
    mesh.scale.set(Math.max(thick, Math.abs(x2 - x1) + (y1 === y2 ? 0 : thick)), Math.max(thick, Math.abs(y2 - y1) + (x1 === x2 ? thick : 0)), 0.05);
  };

  function setTower(parts: TowerParts | null): void {
    if (!parts) {
      towerGroup.visible = false;
      return;
    }
    const { tower } = parts;
    towerGroup.visible = true;
    const width = tower.right - tower.left;
    const grow = Math.min(1, Math.max(0, parts.ground));
    towerGround.visible = grow > 0;
    towerGround.scale.set(Math.max(0.001, (width + 5) * grow), 0.9, 2.6);
    towerGround.position.set(0, tower.ground - 0.45 - 0.08, 0);
    // A plate between floors, then the roof, from the bottom up.
    const heights = [...floorPlates(tower), tower.top + 0.2];
    while (plates.length < heights.length) {
      const plate = new Mesh(unit, plateMaterial);
      plate.castShadow = true;
      plate.receiveShadow = true;
      towerGroup.add(plate);
      plates.push(plate);
    }
    plates.forEach((plate, index) => {
      const shown = index < heights.length ? Math.min(1, Math.max(0, parts.floors - index)) : 0;
      plate.visible = shown > 0;
      if (!plate.visible) return;
      const roof = index === heights.length - 1;
      plate.scale.set((width + 1.2) * (0.35 + 0.65 * shown), roof ? 0.42 : 0.3, 1.9);
      plate.position.set(0, heights[index]!, 0);
    });
    // The deadline: level over the marbles that make it, stepping down where a row is shared.
    const line = parts.line;
    lineParts.forEach((mesh) => (mesh.visible = Boolean(line && line.shown > 0)));
    if (line && line.shown > 0) {
      const at = floorLine(tower, line.count);
      lineMaterial.opacity = Math.min(1, line.shown);
      bar(lineParts[0]!, at.from, at.leftY, at.stepX, at.leftY, LINE);
      bar(lineParts[1]!, at.stepX, at.rightY, at.stepX, at.leftY, LINE);
      bar(lineParts[2]!, at.stepX, at.rightY, at.to, at.rightY, LINE);
      lineParts[1]!.visible = at.leftY !== at.rightY;
    }
    // The bracket, on the tower's left, from the first marble of the band to the last.
    const band = parts.band;
    bracketParts.forEach((mesh) => (mesh.visible = Boolean(band && band.shown > 0 && band.to > band.from)));
    if (band && band.shown > 0 && band.to > band.from) {
      const bottom = floorLine(tower, band.from).leftY;
      const topY = floorLine(tower, band.to).leftY;
      const x = tower.left - 1.7;
      bracketMaterial.opacity = 0.75 * Math.min(1, band.shown);
      bar(bracketParts[0]!, x, bottom, x, topY, 0.26);
      bar(bracketParts[1]!, x, topY, x + 1, topY, 0.26);
      bar(bracketParts[2]!, x, bottom, x + 1, bottom, 0.26);
    }
  }

  return {
    group,
    marbles,
    bounds: { left: plinthLeft, right: plinthRight, bottom: -PLINTH, top: top + RAIL, back: -PLAY_HALF_DEPTH - PANEL, front: PLINTH_DEPTH },
    drawerY: -PLINTH + 1.2,
    setTrapdoor(open) {
      hinge.rotation.x = open * 1.25;
    },
    setFolded,
    setTower,
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      shadowTexture.dispose();
      pegs.dispose();
      marbles.dispose();
    },
  };
}

/** A soft rounded shadow, darkest in the middle (white is shadow: it is used as an alpha map). */
function contactShadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = '#000';
  paint.fillRect(0, 0, 512, 128);
  paint.filter = 'blur(14px)';
  paint.fillStyle = '#fff';
  paint.beginPath();
  paint.roundRect(48, 40, 416, 48, 24);
  paint.fill();
  paint.filter = 'blur(4px)';
  paint.fillStyle = 'rgba(255, 255, 255, 0.9)';
  paint.beginPath();
  paint.roundRect(60, 54, 392, 20, 10);
  paint.fill();
  return new CanvasTexture(canvas);
}

/** A marble's matrix: where it is, at full size (or scaled, as it leaves). */
export function marbleMatrix(target: Matrix4, x: number, y: number, z = 0, scale = 1): Matrix4 {
  return target.compose(TMP_POSITION.set(x, y, z), IDENTITY, TMP_SCALE.setScalar(scale));
}
const TMP_POSITION = new Vector3();
const TMP_SCALE = new Vector3();
const IDENTITY = new Quaternion();
