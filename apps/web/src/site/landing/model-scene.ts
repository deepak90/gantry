/**
 * The landing page's model: Harbor Street Offices on its lot, as the app's own site view builds it (gantt/fx3d), played
 * through the story in model-story.ts. Loaded only when the hero nears the screen: three.js and the building are this
 * chunk.
 *
 * Drawn the way the app draws the building (its stage: the sun, the sky, soft shadows and the occlusion where things
 * meet), less the bloom, since nothing here is lit. The canvas is see-through, so the model's board stands on the
 * page's own paper, with only its shadow on it.
 */
import { Box3, DirectionalLight, HemisphereLight, Mesh, type MeshStandardMaterial, NeutralToneMapping, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, ShadowMaterial, SRGBColorSpace, type Texture, Vector3, WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createBuilding } from '../../gantt/fx3d/building';
import { readBuilding } from '../../gantt/fx3d/building-plan';
import { BASE_BOTTOM, FOOTPRINT, NEIGHBORS } from '../../gantt/fx3d/building-site';
import { createStage } from '../../gantt/fx3d/building-stage';
import { mixPose, placeCamera, type Pose } from '../../gantt/fx3d/rig';
import rows from '../media/harbor-plan.json';
import { type HarborPlanRow, planTasks } from './harbor';
import { dayStart, machineClock, OPENING_DAY, orbitAt, paceAt, storyDate } from './model-story';

/** The frame the model is composed for (model.css keeps the picture at it); any other shape shows the same picture, centered. */
const FRAME_ASPECT = 16 / 10;
/** A long lens, as a model is photographed: little distortion, the building upright. */
const LENS = 24;
const MAX_PIXEL_RATIO = 2;
/** Days of the plan a second, past which a pour is over too quickly to show its trucks. */
const PUMP_PACE = 4;

/** Points the page pins its labels to: over the slab, and by the footings. */
const ANCHORS = {
  hold: new Vector3(-40, -36, 8),
  paid: new Vector3(-147, -97, 2),
} as const;
export type AnchorName = keyof typeof ANCHORS;

export interface HeroScene {
  canvas: HTMLCanvasElement;
  /** Draws the story at a moment (seconds). The same moment always draws the same picture. */
  draw(seconds: number): void;
  /** Where an anchor is on the canvas, in CSS pixels, at the last draw; null when it is behind the camera. */
  anchor(name: AnchorName): { x: number; y: number } | null;
  /** The canvas's size in CSS pixels. */
  resize(width: number, height: number): void;
  /**
   * How much it draws, for a machine that cannot keep up: 0 everything; 1 without the occlusion; 2 and 3 also at fewer
   * pixels (1.5 and 1 to a CSS pixel).
   */
  quality(level: number): void;
  dispose(): void;
}

export const QUALITY_LEVELS = 4;

/** Lets the page get on with its own work between the heavy steps of setting the model up. */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The fill over the footings, see-through until the slab's base goes in, so the footings that were paid for show. */
function revealAt(date: number): number {
  const from = dayStart(OPENING_DAY, 1);
  const to = dayStart(OPENING_DAY, 3);
  const t = Math.min(1, Math.max(0, (date - from) / (to - from)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * What the camera keeps in the frame: the board, top and bottom, the neighbors standing on it, and the building as tall
 * as it stands (or as its outline, drawn from the start).
 */
const BOARD = { x0: -420, x1: 450, y0: -410, y1: 340 } as const;
const corners = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) => [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [new Vector3(x, y, z0), new Vector3(x, y, z1)]));
const silhouette = (buildingTop: number) => [
  ...corners(BOARD.x0, BOARD.y0, BOARD.x1, BOARD.y1, BASE_BOTTOM, 0),
  ...NEIGHBORS.flatMap(([x0, y0, x1, y1, height]) => corners(x0, y0, x1, y1, height, height)),
  ...corners(FOOTPRINT.x0, FOOTPRINT.y0, FOOTPRINT.x1, FOOTPRINT.y1, 0, buildingTop),
];

const probe = new PerspectiveCamera(LENS, FRAME_ASPECT, 20, 20_000);
const seen = new Vector3();
const across = new Vector3();
const upward = new Vector3();

/** The pose that fits these points in the frame from this side and this high, with `pad` of the frame left round them. */
function fitPose(points: readonly Vector3[], azimuth: number, elevation: number, pad = 0.06): Pose {
  const target = new Box3().setFromPoints(points as Vector3[]).getCenter(new Vector3());
  const extent = (distance: number) => {
    placeCamera(probe, { x: target.x, y: target.y, z: target.z, azimuth, elevation, distance });
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const point of points) {
      seen.copy(point).project(probe);
      minX = Math.min(minX, seen.x);
      maxX = Math.max(maxX, seen.x);
      minY = Math.min(minY, seen.y);
      maxY = Math.max(maxY, seen.y);
    }
    return { minX, maxX, minY, maxY };
  };
  let distance = 2000;
  for (let pass = 0; pass < 3; pass++) {
    let [near, far] = [100, 40_000];
    for (let step = 0; step < 40; step++) {
      const mid = (near + far) / 2;
      const span = extent(mid);
      if (span.maxX - span.minX <= 2 * (1 - pad) && span.maxY - span.minY <= 2 * (1 - pad)) far = mid;
      else near = mid;
    }
    distance = far;
    const span = extent(distance);
    const halfTan = Math.tan((LENS * Math.PI) / 360);
    across.setFromMatrixColumn(probe.matrixWorld, 0);
    upward.setFromMatrixColumn(probe.matrixWorld, 1);
    target.addScaledVector(across, ((span.minX + span.maxX) / 2) * distance * halfTan * FRAME_ASPECT);
    target.addScaledVector(upward, ((span.minY + span.maxY) / 2) * distance * halfTan);
  }
  return { x: target.x, y: target.y, z: target.z, azimuth, elevation, distance };
}

/** The camera at the first moment and once it has settled: round from the street corner as the building rises. */
const OPENING: Pose = fitPose(silhouette(275), -0.78, 0.98, 0.07);
const CLOSING: Pose = fitPose(silhouette(275), -0.52, 0.98, 0.07);

/**
 * Sets the model up on a canvas, in steps that each leave the page free in between: the renderer and its light, the
 * building, the shaders (compiled in parallel where the browser can), the textures. Resolves once it can draw without a
 * stall; rejects where WebGL is missing.
 */
export async function createHeroScene(canvas: HTMLCanvasElement = document.createElement('canvas')): Promise<HeroScene> {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
  try {
    return await setUp(renderer, canvas);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}

async function setUp(renderer: WebGLRenderer, canvas: HTMLCanvasElement): Promise<HeroScene> {
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const deviceRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(deviceRatio);

  const scene = new Scene();
  // The room-light reflections that give the glass and the steel their sheen, as in the app.
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = environment;

  // Near and far round the board only, so the depth the shadows and the occlusion read is as fine as it can be.
  const camera = new PerspectiveCamera(LENS, FRAME_ASPECT, 300, 8000);
  camera.up.set(0, 0, 1);
  // The stage's own light, with a shadow map fitted to the board: the model is small on the page, so half the app's.
  const lights = { sun: new DirectionalLight(), sky: new HemisphereLight() };
  scene.add(lights.sun, lights.sun.target, lights.sky);
  const stage = createStage(renderer, scene, camera, lights, { bloom: false, transparent: true });
  lights.sun.shadow.mapSize.set(2048, 2048);
  stage.fitShadow(new Vector3(15, -35, 0), 640);
  await yieldToPage();

  const plan = readBuilding(planTasks(rows as unknown as HarborPlanRow[]));
  if (!plan) throw new Error('model-scene: Harbor’s plan is not a building');
  const model = createBuilding(plan, { idleRings: false });
  scene.add(model.root);
  model.setOffsets(plan.layers.map(() => 0));
  model.setCutaway(0);
  // The pump and the mixer, which stand on the street for a pour.
  const trucks = model.root.children.filter((child) => child.userData.machine === 'pump' || child.userData.machine === 'mixer');

  // The table the board stands on: nothing but the shadow falling on it.
  const table = new Mesh(new PlaneGeometry(6000, 6000), new ShadowMaterial({ opacity: 0.12, depthWrite: false }));
  table.position.z = BASE_BOTTOM + 0.05;
  table.receiveShadow = true;
  scene.add(table);
  await yieldToPage();

  placeCamera(camera, OPENING);
  await renderer.compileAsync(scene, camera);
  await yieldToPage();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    const materials = (object as Mesh).material;
    for (const material of (Array.isArray(materials) ? materials : materials ? [materials] : []) as MeshStandardMaterial[]) if (material.map) textures.add(material.map);
  });
  for (const texture of textures) renderer.initTexture(texture);
  await yieldToPage();

  let width = 1;
  let height = 1;
  const projected = new Vector3();
  let last = -1;

  function resize(nextWidth: number, nextHeight: number): void {
    width = Math.max(1, Math.round(nextWidth));
    height = Math.max(1, Math.round(nextHeight));
    renderer.setSize(width, height, false);
    stage.setSize(width, height, renderer.getPixelRatio());
    camera.aspect = width / height;
    // Narrower than the frame: the lens opens up, so the frame's width still fits.
    const tall = camera.aspect < FRAME_ASPECT;
    camera.fov = tall ? (2 * Math.atan(Math.tan((LENS * Math.PI) / 360) * (FRAME_ASPECT / camera.aspect)) * 180) / Math.PI : LENS;
    camera.updateProjectionMatrix();
  }

  function draw(seconds: number): void {
    last = seconds;
    const date = storyDate(seconds);
    model.setDate(date);
    model.site.setReveal(revealAt(date));
    model.update(1 / 60, machineClock(seconds));
    // While the date runs fast a deck's pour is over in a frame or two, and its trucks would only flicker: they come for
    // the slab's, which the story takes slowly.
    if (paceAt(seconds) > PUMP_PACE) for (const truck of trucks) truck.visible = false;
    placeCamera(camera, mixPose(OPENING, CLOSING, orbitAt(seconds)));
    stage.render();
  }

  return {
    canvas,
    draw,
    anchor(name) {
      if (last < 0) return null;
      projected.copy(ANCHORS[name]).project(camera);
      if (projected.z > 1) return null;
      return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height };
    },
    resize,
    quality(level) {
      stage.setQuality(level >= 1 ? 1 : 0);
      renderer.setPixelRatio(level >= 3 ? 1 : level >= 2 ? Math.min(deviceRatio, 1.5) : deviceRatio);
      resize(width, height);
    },
    dispose() {
      model.dispose();
      stage.dispose();
      scene.remove(lights.sun, lights.sun.target, lights.sky);
      lights.sun.dispose();
      lights.sky.dispose();
      table.geometry.dispose();
      (table.material as ShadowMaterial).dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
