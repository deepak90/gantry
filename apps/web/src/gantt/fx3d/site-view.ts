/**
 * The site board: the plan as a site you can walk through in time. The work stands in the order it is
 * built, along one road that turns back at the end of each phase. The date decides everything on it: what
 * has not started is a pale model, as a bar that has not started is a ghost on the chart; what is under way
 * is being built, with its crew on it; what is finished stays, and the road lights up behind it. Four lenses
 * ask the same date a different question: what is being built, what the money has done, who is on site, and
 * what needs attention. Everything comes from the plan: WBS numbers, bar colors, constraints, deadlines,
 * rentals, and where each payment stands at PayPal.
 *
 * It is one continuous place with three scenes in it (site-nav.ts): leaving the chart, every bar lifts off,
 * thickens into a box, and arcs to its plot; going into a piece of work, its plot grows into a cutaway room in
 * place while the board becomes a plan on graph paper around it. Everything runs on one or two numbers, so each
 * move can stop and reverse from wherever it is, and coming back is the same move played backward.
 *
 * A room is a stage for one piece of work on one date: its materials, equipment and debris (room-set.ts), every
 * day of its machine's rental and its work along the front, with what each idle day costs (day-track.ts), and the
 * same four lenses, standing in the room. The rail closes in on its days, so they can be scrubbed one by one.
 */
import type { DependencyModel, Gantt, ResourceModel, TaskModel } from '@bryntum/gantt';
import { animate } from 'motion';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  type PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RepeatWrapping,
  type Scene,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { compactMoney, crewColor, engineCommitting, leadCrew, type LookState, original, ownTaskColor, phaseClass, slipDays, wholeMoney } from '../look';
import { createDateRail, type DateRail, middayOf, type RailBar } from './date-rail';
import { createDayTrack, dayKey, type DayTile, type DayTrack, dayWords, idleCostBy, paintIdleStrip, paintSlack, rentalUse, spentWords, workDaysBegun } from './day-track';
import { colorOverChart, colorOverRoom, dropHeight, ESCAPE_SECONDS, FALL_SECONDS, fallStage, fillHeight, overBar } from './fall';
import { type CostLine, type MoneyRow, rowsByFirm } from './cost-breakdown';
import { crewZones, paintCrewMark, standingSpots } from './crew-floor';
import { createFlowline, type Flowline, type FlowWork } from './flowline';
import { createMoneyChart } from './money-chart';
import { createGraphPaper, PAPER, PLAN_LINE } from './paper';
import type { SignPart } from './standing-models';
import { progressAt, type Progress, reportedProgress, shortDate } from './facts';
import { bakeInto, buildKit, type Kit } from './kits';
import { cssColor, disposeDeep, tokenColor } from './page';
import type { Worker, WorkerKit } from './people';
import { createMaterials, easeOut, figure, lerp, smooth, solid, upright, within } from './parts';
import { type Box, createPlate, overlaps, type Plate, type PlateLine, plateLevel, standingOf } from './plates';
import { FOV, mixPose, placeCamera, type Pose, restDistance, restPose } from './rig';
import { createFrontMarker, type FrontMarker, type FrontRoute, frontRoute, type FrontStop } from './road-marker';
import type { PropKit } from './props';
import { roomJobs } from './room-jobs';
import { dressRoom, type RoomSet } from './room-set';
import { crewNames, idleStretches, layoutRoad, payCheckWords, type Point, ROAD, type RoadItem, type RoadPlot, roadRoute, roundedRoute, siteTasks, type SiteTask } from './site-facts';
import { type NavPlan, type Scene as SiteScene, sceneToShow, stepsFrom, trailOf, upFrom, worksWithin } from './site-nav';
import type { SidePanel } from './side-panel';
import type { Companion } from './companion';
import { type BoardRow, createWallBoard, type WallBoard } from './wall-board';
import { ASSISTANT_NAME } from '../../assistant/identity';
import { remyMarkElement } from '../../assistant/RemyMark';
import { planClock } from '../../plan-clock';

export type Lens = 'work' | 'money' | 'crew' | 'issues';

export interface SiteContext {
  gantt: Gantt;
  look: () => LookState;
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  materials: ReturnType<typeof createMaterials>;
  reducedMotion: boolean;
  size: () => { width: number; height: number };
  workers: () => WorkerKit | null;
  props: () => PropKit | null;
  /** Settled when the people's models have loaded, or failed to. */
  workersReady: Promise<unknown>;
  pin: () => readonly SignPart[] | null;
  makeBlockFace: (wrap: HTMLElement, bar: HTMLElement) => CanvasTexture;
  setLive: (live: boolean) => void;
  sheetOpacity: (value: number) => void;
  fitShadow: (x: number, y: number, reach: number) => void;
  showTable: (x: number, y: number, z: number, reach: number, opacity: number, ground: number) => void;
  /** A room's plain paper and the fog around it, from nothing to all of it. */
  setAtmosphere: (shown: number, focusDistance: number) => void;
  /** Scales the page with the camera as it falls toward it, or puts it back with null. */
  sheetTransform: (scale: number | null, x?: number, y?: number) => void;
  /** Gives the camera to the person: with bounds it moves like a map and stays over them, without it turns. How far out it may go is at least `farthest` allows. */
  handToControls: (pose: Pose, bounds?: { w: number; d: number }, farthest?: number) => void;
  takeFromControls: () => Pose;
  wake: () => void;
  editTask: (task: TaskModel) => void;
  openPayment?: (task: TaskModel) => void;
  /** Selects the work in the plan, so that what the assistant is asked is about it. */
  selectTask: (task: TaskModel) => void;
  /** The app's side panel over the scene: the task editor, the assistant and the watch list. */
  panel: SidePanel;
  /** The assistant's face over the scene: a view sends it to whatever it points at. */
  companion: Companion;
}

export interface SiteView {
  /** Opens on the board, or straight in a piece of work. */
  open(work?: TaskModel): Promise<void>;
  close(after?: () => void): void;
  /** One level up: from a piece of work to the board, from the board to the chart. */
  up(): void;
  /** The work someone was last in when they left for the chart, to offer a way back. */
  lastWork(): TaskModel | null;
  update(dt: number, time: number): Pose | null;
  afterCamera(): void;
  hover(x: number, y: number): void;
  click(x: number, y: number): void;
  doubleClick(x: number, y: number): void;
  resized(): void;
  /** The plan or what is known about it changed: what is on show follows, wherever it was changed from. */
  planChanged(): void;
  /** Tasks someone pointed at from outside the scene (a card, a link, the task panel): the scene goes to them. */
  show(taskIds: readonly number[]): void;
  /** The side panel opened (true), closed (false) or changed what it shows (null). */
  panelChanged(opening: boolean | null): void;
  /** Up and settled: not on its way in from the chart or back out to it. Without it, up is settled. */
  settled?(): boolean;
  /**
   * The tower crane, for Remy when someone asks her: its days on rent on the lot (`days`), the view from up on it
   * (`ride`), or back down (`down`), as its buttons do. False when this view has no crane to show.
   */
  crane?(look: 'days' | 'ride' | 'down'): boolean;
  /** The building's days and levels, for Remy when someone asks her (the building view has them; the board does not). */
  control?: SiteControl;
  destroy(): void;
}

/** What the 3D view's own controls do with its days and levels: the play button, the date rail, the floors list. */
export interface SiteControl {
  /** The day on show (YYYY-MM-DD), whether its days are playing, up on the crane, and the level looked at. */
  state(): { day: string | null; playing: boolean; riding: boolean; level: string | null };
  /** The levels by name ("Level 2") and short name ("L2"), the foundations first. */
  levels(): readonly { name: string; short: string }[];
  /** The first and last instants the date rail runs over. */
  span(): readonly [number, number] | null;
  /** Plays the days from `from` (the day on show when null) to `to` (the end when null), in about `seconds`. False when it can't now. */
  play(from: number | null, to: number | null, seconds: number | null): boolean;
  pause(): void;
  /** Shows a day; false when it can't now. */
  goTo(day: number): boolean;
  /** Looks at a level by its name or short name, or at the whole site (null); false when there is no such level. */
  level(name: string | null): boolean;
}

const BAR_SELECTOR = '.b-gantt-task-wrap:not(.b-gantt-task-parent, .b-milestone-wrap)';
/** The board's side margins: the left one holds the phase names, as a chart's table does. */
const MARGIN_X = 250;
const MARGIN_Y = 80;
/** Past this many tasks a board of models would be a blur (and slow), so only machines get one. */
const MODEL_LIMIT = 40;
const MODEL_SCALE = 0.42;
const WORKER_HEIGHT = 38;
/** One figure for each person, up to this many on a plot: the mark on the floor always says the real number. */
const MOST_FIGURES = 10;
const SECONDS_PER_DAY = 0.2;
const SPOTLIGHT_MS = 6000;
/** How long something just added may take to reach the board before saying it isn't there. */
const CATCH_UP_MS = 4000;
const OPEN_SECONDS = 3.1;
const CLOSE_SECONDS = 2.5;
const ROOM_HEIGHT = 196;
const ROOM_HEIGHT_LOW = 132;
/** A model stands a little larger in its own room than on the board, unless it already reaches the top of the walls. */
const ROOM_MODEL_GROWTH = 1.16;
const ROOM_WORKER = 21;
/** Wider in a room: close to the work, with the sky over it. */
const ROOM_FOV = 46;
const ROOM_ELEVATION = 1.3;
const ROOM_AZIMUTH = -0.78;
/** A day takes longer inside one piece of work, so a coin landing on an idle day can be seen. */
const SECONDS_PER_DAY_IN_WORK = 0.55;
/** A machine's dates and the work's, with a few days around them, is what the rail shows in a room. */
const WINDOW_MARGIN_DAYS = 3;
const BOARD_WALL = 214;
const DAY_MS = 86_400_000;
const PLINTH = 9;
/** How far apart stacked money sits, so that no two surfaces of a column share a height. */
const MONEY_GAP = 0.5;
/** The small gap between the segments of a stacked bar, which is also what keeps their surfaces apart. */
const STACK_GAP = 1.6;

const LENSES: { id: Lens; label: string; key: string }[] = [
  { id: 'work', label: 'Work', key: '1' },
  { id: 'money', label: 'Money', key: '2' },
  { id: 'crew', label: 'Crew', key: '3' },
  { id: 'issues', label: 'Issues', key: '4' },
];

interface GhostEntry {
  mesh: Mesh;
  real: Material;
  machine: boolean;
  casts: boolean;
}

/** A job's money as a column that rises with the date: a pale form of all it will cost, filling up by who it paid. */
interface MoneyBars {
  group: Group;
  /** How tall a layer should be, and how tall it is on its way there. */
  segments: { fill: Mesh; height: number; shown: number; line: CostLine }[];
  top: number;
  shell: Mesh;
  shellShown: number;
  layer: BoxGeometry;
  unit: number;
}

interface RoomLabel {
  element: HTMLElement;
  /** Where it points, in the plot's own space; asked for each frame, because people walk. */
  at: () => Vector3 | null;
  lenses: readonly Lens[];
  refresh: () => { text: string; tone?: string; live?: boolean } | null;
}

/** What makes a plot a room: its props, its days, what is on its wall, and what each lens stands in it. */
interface RoomStage {
  set: RoomSet;
  track: DayTrack;
  board: WallBoard;
  /** Each wall with what is on it, so the one between the camera and the work can step aside. */
  backWall: Group;
  sideWall: Group;
  floor: Mesh;
  money: { bars: MoneyBars; u: number } | null;
  crewMarks: Group | null;
  pins: { group: Group; lamp: MeshStandardMaterial; from: number; to: number }[];
  pinsU: number;
  labels: RoomLabel[];
  /** The tone of the last repaint, so the wall is only painted when it has something new to say. */
  painted: string;
  /** Stands the work's issues in the room anew, and letters its dates on the wall anew: both follow the plan. */
  standIssues: () => void;
  paintTitle: () => void;
}

interface Piece {
  site: SiteTask;
  plot: RoadPlot;
  /** Where its bar is on the chart. A bar the chart has scrolled out of sight leaves from the nearest edge instead. */
  from: { x: number; y: number; w: number; d: number; outOfSight: boolean };
  delay: number;
  group: Group;
  /** The amber idle strip, if its machine is booked for days with no work planned. */
  idleStrip: Mesh | null;
  /** The plot's front edge marks, which belong to the board: the room has its day track instead. */
  edgeMarks: Mesh[];
  rim: MeshPhysicalMaterial;
  /** The same plot's looks when the board colors by firm, and its keel to follow them. */
  crewLook: { bar: Color; ghost: Color; done: Color } | null;
  keel: MeshStandardMaterial | null;
  /** The pale strip after the plot: how far this work can slip. */
  slackStrip: Mesh | null;
  slackU: number;
  /** The plot's solid: what grows from a bar into a box, and from a box into a room's floor. */
  body: Group;
  /** All that stands on the plot, which arrives once the box has landed. */
  dressing: Group;
  plinth: Mesh;
  shell: MeshPhysicalMaterial;
  barColor: Color;
  ghostColor: Color;
  doneColor: Color;
  band: Mesh;
  check: Mesh;
  face: Mesh | null;
  faceMaterial: MeshBasicMaterial | null;
  kit: Kit | null;
  /** Made when its room first opened, on a board too large to have models. */
  roomOnlyModel: boolean;
  ghosts: GhostEntry[];
  /** The finished work in pale: there before it starts, and thinning out while the real one is built inside it. */
  ghostKit: Object3D | null;
  ghostMaterial: MeshStandardMaterial;
  paleMaterial: MeshStandardMaterial;
  realMode: 'hidden' | 'machine' | 'full';
  room: Group | null;
  stage: RoomStage | null;
  plate: Plate | null;
  roomU: number;
  shown: number;
  work: Group;
  money: MoneyBars | null;
  crew: Group;
  crewMarks: Group;
  workers: Worker[];
  /** Where each person stands on the board, so they go back there after a room. */
  spots: { worker: Worker; crew: number; x: number; y: number; area: { x: number; y: number; w: number; d: number } }[];
  beacon: { group: Group; light: MeshStandardMaterial } | null;
  gate: Group | null;
  puck: Group | null;
  hit: Mesh;
  u: { work: number; money: number; crew: number; beacon: number; hover: number };
  progress: Progress;
  /** The color of its bar on the rail. */
  railColor: string;
  /** What fixes made while this was open took off its idle days. */
  savedMinor: number;
  idleU: number;
}

/** three walks over every object each frame, seen or not: this leaves out one that can't be seen, and all under it. */
function skipWhileHidden(object: Object3D): void {
  const walk = object.updateMatrixWorld.bind(object);
  object.updateMatrixWorld = (force?: boolean): void => {
    if (object.visible) walk(force);
  };
}

interface Lane {
  mesh: Mesh;
  /** When the work at the start of this lane is finished, and the road beyond it lights up. */
  doneAt: number;
  from: TaskModel;
  to: TaskModel;
}

interface Shot {
  from: Pose;
  to: Pose;
  t: number;
  seconds: number;
}

interface PhaseBar {
  track: Mesh;
  fill: Mesh;
  tasks: Piece[];
  width: number;
}

const BOARD_DIRECTIONS = 'Drag to move · Scroll or pinch to zoom · Right-drag or Shift-drag to turn and tilt';
const WORK_DIRECTIONS = 'Drag to turn and tilt · Right-drag to move · Scroll or pinch to zoom · Double-click to edit';

/** Chevrons along a lane, so it says which way the work goes without an arrowhead at every end. */
function chevronTexture(bed: string, mark: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.fillStyle = bed;
  context.fillRect(0, 0, 128, 64);
  context.strokeStyle = mark;
  context.lineWidth = 11;
  context.lineCap = 'butt';
  context.lineJoin = 'miter';
  context.beginPath();
  context.moveTo(40, 8);
  context.lineTo(72, 32);
  context.lineTo(40, 56);
  context.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function stripesTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 16;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#e7ad1c';
  context.fillRect(0, 0, 64, 16);
  context.fillStyle = '#20262e';
  for (let x = -16; x < 64; x += 16) {
    context.beginPath();
    context.moveTo(x, 16);
    context.lineTo(x + 8, 16);
    context.lineTo(x + 16, 0);
    context.lineTo(x + 8, 0);
    context.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  return texture;
}

function checkTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = tokenColor('--success');
  paint.beginPath();
  paint.arc(32, 32, 30, 0, Math.PI * 2);
  paint.fill();
  paint.strokeStyle = '#ffffff';
  paint.lineWidth = 7;
  paint.lineCap = 'round';
  paint.lineJoin = 'round';
  paint.beginPath();
  paint.moveTo(18, 33);
  paint.lineTo(28, 43);
  paint.lineTo(46, 22);
  paint.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A flat ribbon along a route, its length carried in the texture coordinate so chevrons keep their size. */
function ribbon(points: readonly Point[], width: number, z: number, tile: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let length = 0;
  points.forEach((point, index) => {
    const before = points[index - 1] ?? point;
    const after = points[index + 1] ?? point;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const span = Math.hypot(dx, dy) || 1;
    const nx = (-dy / span) * (width / 2);
    const ny = (dx / span) * (width / 2);
    if (index > 0) length += Math.hypot(point.x - before.x, point.y - before.y);
    positions.push(point.x + nx, point.y + ny, z, point.x - nx, point.y - ny, z);
    uvs.push(length / tile, 1, length / tile, 0);
    normals.push(0, 0, 1, 0, 0, 1);
    if (index > 0) {
      const a = (index - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

/** What a model is made of, so it can turn pale until its work starts. Its machines can stay real: they arrive first. */
function ghostEntries(root: Object3D): GhostEntry[] {
  const entries: GhostEntry[] = [];
  const walk = (node: Object3D, machine: boolean): void => {
    const isMachine = machine || Boolean(node.userData.machine);
    const mesh = node as Mesh;
    if (mesh.isMesh) entries.push({ mesh, real: mesh.material as Material, machine: isMachine, casts: mesh.castShadow });
    for (const child of node.children) walk(child, isMachine);
  };
  walk(root, false);
  return entries;
}

function topLevelOf(task: TaskModel): unknown {
  let node = task as unknown as { parent?: { isRoot?: boolean } | null };
  while (node.parent && !node.parent.isRoot) node = node.parent as typeof node;
  return node;
}

const cssColorText = (color: Color): string => `#${color.getHexString()}`;

export function createSiteView(context: SiteContext): SiteView {
  const { gantt, look, scene: threeScene, camera, renderer, materials: m, reducedMotion } = context;
  /** What the other plots turn into around a room: drawn on the sheet, in a thin line. */
  const planPaper = new Color(PAPER);
  const planLine = new Color(PLAN_LINE);
  const keelDark = new Color('#101418');
  let barRectFor: (record: TaskModel) => Piece['from'] = () => ({ x: 0, y: 0, w: 1, d: 1, outOfSight: false });
  const inOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const damp = (from: number, to: number, rate: number, dt: number): number => from + (to - from) * (1 - Math.exp(-rate * dt));

  let root: Group | null = null;
  let pieces: Piece[] = [];
  let lanes: Lane[] = [];
  let phaseBars: PhaseBar[] = [];
  let gems: { group: Group; at: number; stone: Mesh; post: Mesh; record: TaskModel }[] = [];
  let boardMaterials: (MeshStandardMaterial | MeshPhysicalMaterial)[] = [];
  let laneMaterials: { ahead: MeshStandardMaterial; done: MeshStandardMaterial; lit: MeshStandardMaterial } | null = null;
  let extraMaterials: Material[] = [];
  let rail: DateRail | null = null;
  let pose: Pose | null = null;
  let home: Pose | null = null;
  let shot: Shot | null = null;
  let handed = false;
  let scene: SiteScene<TaskModel> = { kind: 'chart' };
  let focus: Piece | null = null;
  /** How far the board has stepped back for one piece of work. */
  let focusU = 0;
  let navPlan: NavPlan<TaskModel> = { order: [], name: () => '' };
  let slotted: HTMLElement[] = [];
  let boardWalls: Group | null = null;
  let graphPaper: ReturnType<typeof createGraphPaper> | null = null;
  let dateBoard: WallBoard | null = null;
  let boardBackWall: Group | null = null;
  let boardSideWall: Group | null = null;
  let phasePlates: { plate: Plate; at: Vector3; tasks: Piece[]; name: string; start: number; end: number }[] = [];
  let milestonePlates: { plate: Plate; at: Vector3; record: TaskModel; name: string; date: string; late: number }[] = [];
  let wholePlanOnRail = false;
  let railWindow: [number, number] = [0, 1];
  let stopRailMove: (() => void) | undefined;
  let stopGlide: (() => void) | undefined;
  let picking = false;
  /** The fall into a bar or back out of it; the board and the room are behind it the whole time. */
  let fall: { value: number; bar: { x: number; y: number; w: number; d: number }; room: Pose; high: Pose } | null = null;
  /** The money chart's rows: by phase with its jobs, or by firm. */
  let moneyBy: 'job' | 'crew' = 'job';
  /** The shape of the plan the scene was built from: when that changes, it is built again. */
  let builtShape = '';
  let planWaiting = false;
  let boardColors: Record<string, MeshStandardMaterial> = {};
  const offered = new WeakSet<Piece>();
  let railBuild: (() => void) | null = null;
  let readFrontStops: (() => FrontStop[]) | null = null;
  let flowWorksNow: (() => FlowWork[]) | null = null;
  let stopMorph: (() => void) | undefined;
  let hoveredTile: DayTile | null = null;
  let pickedAt: number | null = null;
  /** This room was entered through its bar, so leaving it goes back the same way. */
  let fromChart = false;
  /** Labels fade out, change, and fade in when the lens changes, rather than swapping under the eye. */
  let plateDim = 1;
  let lensChanging = false;
  // What the Show menu has on. It stays as it was left, between visits.
  const showing = { front: true, slack: false, crew: false, flow: false };
  let front: { route: FrontRoute; marker: FrontMarker; tag: HTMLElement; u: number } | null = null;
  let flowline: Flowline | null = null;
  let flowlineWorks: FlowWork[] = [];
  let flowlineRows: string[] = [];
  let nothing: MeshBasicMaterial | null = null;
  // What carries over between visits: the same date and lens, and the work someone left for the chart.
  let keptDate: number | null = null;
  let keptLens: Lens = 'work';
  let keptWork: TaskModel | null = null;
  let s = 0;
  let now = 0;
  let lastDay = -1;
  let span = { start: 0, end: 1 };
  let lens: Lens = 'work';
  let playing = false;
  let stopTransition: (() => void) | undefined;
  let stopPlay: (() => void) | undefined;
  let hovered: Piece | null = null;
  let railHover: unknown = null;
  let pinned: Piece | null = null;
  let opening = false;
  // Being pointed at something from outside: what is waiting for a move to finish, what is lit up now.
  let wanted: readonly number[] | null = null;
  let awaitedSince = 0;
  let quiet = false;
  const spotlit = new Set<Piece>();
  let spotlightTimer = 0;
  let closing = false;
  let shadowsMoving = 1;
  let shadowTick = 0;
  let boardReach = 1000;
  let boardSize = { w: 1, d: 1 };
  let peakMoney = 1;
  const pointer = new Vector2();
  const ray = new Raycaster();
  const tagPoint = new Vector3();

  // ---------------------------------------------------------------------------------------
  // The controls, under the board, and what the date means, beside it
  // ---------------------------------------------------------------------------------------

  const bar = document.createElement('div');
  bar.className = 'fx3d-sitebar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Site board');
  const row = document.createElement('div');
  row.className = 'fx3d-siterow';
  const lensGroup = document.createElement('div');
  lensGroup.className = 'segmented';
  const lensButtons = LENSES.map(({ id, label, key }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = `${label} (${key})`;
    button.addEventListener('click', () => setLens(id));
    lensGroup.append(button);
    return { id, button };
  });
  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'button is-sm';
  const playIcon = document.createElement('i');
  const playLabel = document.createElement('span');
  playButton.append(playIcon, playLabel);
  playButton.addEventListener('click', () => togglePlay());
  const todayButton = document.createElement('button');
  todayButton.type = 'button';
  todayButton.className = 'button is-sm is-quiet';
  todayButton.textContent = 'Today';
  todayButton.addEventListener('click', () => {
    pause();
    setDate(middayOf(Math.min(span.end - DAY_MS / 2, Math.max(span.start, planClock.now().getTime()))));
  });
  const railRangeButton = document.createElement('button');
  railRangeButton.type = 'button';
  railRangeButton.className = 'button is-sm is-quiet';
  railRangeButton.addEventListener('click', () => {
    wholePlanOnRail = !wholePlanOnRail;
    fitRail();
    syncBar();
  });
  const showMenu = document.createElement('details');
  showMenu.className = 'fx3d-show';
  const showLabel = document.createElement('summary');
  showLabel.textContent = 'Show';
  const showList = document.createElement('div');
  showMenu.append(showLabel, showList);
  const showOptions: { id: keyof typeof showing; label: string; hint: string }[] = [
    { id: 'front', label: 'Work front', hint: 'A pin on the road, where the work is on this date' },
    { id: 'slack', label: 'Slack', hint: 'A pale strip after each plot: the days it can slip without moving the handover' },
    { id: 'crew', label: 'Color by firm', hint: 'Plots in the color of the firm doing the work, instead of the phase' },
    { id: 'flow', label: 'Where and when', hint: 'The plan as a flowline: phases down, time across, one line per piece of work' },
  ];
  for (const { id, label, hint } of showOptions) {
    const item = document.createElement('label');
    item.title = hint;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = showing[id];
    box.addEventListener('change', () => {
      showing[id] = box.checked;
      applyShowing();
    });
    item.append(box, label);
    showList.append(item);
  }
  // In a room, the model shows what the plan has by this date or what has been reported done: comparing the two is the point.
  let modelShows: 'planned' | 'reported' = 'planned';
  const modelGroup = document.createElement('div');
  modelGroup.className = 'segmented';
  modelGroup.setAttribute('aria-label', 'The model shows');
  const modelButtons = (['planned', 'reported'] as const).map((id) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = id === 'planned' ? 'Planned' : 'Reported';
    button.title = id === 'planned' ? 'What the plan has by this date' : 'What has been reported done';
    button.addEventListener('click', () => setModelShows(id));
    modelGroup.append(button);
    return { id, button };
  });
  const legend = document.createElement('div');
  legend.className = 'fx3d-legend';
  const homeButton = document.createElement('button');
  homeButton.type = 'button';
  homeButton.className = 'button is-sm';
  homeButton.textContent = 'Reset view';
  homeButton.addEventListener('click', () => frameScene());
  const assistantButton = document.createElement('button');
  assistantButton.type = 'button';
  assistantButton.className = 'button is-sm';
  assistantButton.dataset.testid = 'fx3d-assistant';
  const assistantIcon = remyMarkElement('still', 'fx3d-mark');
  const assistantLabel = document.createElement('span');
  assistantLabel.textContent = ` ${ASSISTANT_NAME}`;
  assistantButton.append(assistantIcon, assistantLabel);
  assistantButton.addEventListener('click', () => {
    if (context.panel.isOpen() && context.panel.tab() === 'assistant') context.panel.close();
    else context.panel.open('assistant');
  });
  row.append(lensGroup, modelGroup, playButton, todayButton, railRangeButton, showMenu, legend, assistantButton, homeButton);
  const railSlot = document.createElement('div');
  railSlot.className = 'fx3d-railslot';
  const railKey = document.createElement('div');
  railKey.className = 'fx3d-railkey';
  const directions = document.createElement('span');
  directions.className = 'fx3d-directions';
  bar.append(row, railSlot, railKey);

  // Where you are and where you can go: always there, drawn from the scene (site-nav.ts).
  const nav = document.createElement('nav');
  nav.className = 'fx3d-nav';
  nav.setAttribute('aria-label', 'Where you are on the site');

  const diary = document.createElement('aside');
  diary.className = 'fx3d-diary';
  diary.setAttribute('aria-live', 'polite');

  const tags = document.createElement('div');
  tags.className = 'fx3d-tags';
  const plateLayer = document.createElement('div');
  plateLayer.className = 'fx3d-plates';
  const roomLayer = document.createElement('div');
  roomLayer.className = 'fx3d-tags';
  // The bar's own color over the canvas: it hides the blur of a page scaled that far, and clears on the room.
  const light = document.createElement('div');
  light.className = 'fx3d-light';
  light.hidden = true;
  const card = document.createElement('div');
  card.className = 'fx3d-card';
  card.setAttribute('role', 'status');
  // What someone pointing at tasks from outside the scene got taken to.
  const caption = document.createElement('div');
  caption.className = 'fx3d-caption';
  caption.dataset.testid = 'fx3d-caption';
  caption.setAttribute('role', 'status');
  caption.hidden = true;
  // After a fix has landed: how it came out, and whether to go and pay for it.
  const offer = document.createElement('div');
  offer.className = 'fx3d-offer';
  offer.dataset.testid = 'fx3d-offer';
  offer.setAttribute('role', 'status');
  offer.hidden = true;

  function swatch(color: string, text: string, shape = ''): HTMLElement {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = color;
    if (shape) dot.className = shape;
    item.append(dot, text);
    return item;
  }

  function syncBar(): void {
    const canSeeMoney = look().canViewCosts;
    for (const { id, button } of lensButtons) {
      button.setAttribute('aria-pressed', String(id === lens));
      if (id === 'money') {
        button.disabled = !canSeeMoney;
        button.title = canSeeMoney ? 'Money (2)' : 'Costs are hidden for your role';
      }
    }
    playIcon.className = playing ? 'fa fa-pause' : 'fa fa-play';
    playLabel.textContent = playing ? ' Pause' : ' Play';
    const inWork = scene.kind === 'work';
    modelGroup.hidden = !inWork || lens !== 'work';
    for (const { id, button } of modelButtons) button.setAttribute('aria-pressed', String(id === modelShows));
    todayButton.hidden = inWork;
    railRangeButton.hidden = !inWork;
    showMenu.hidden = inWork;
    railRangeButton.textContent = wholePlanOnRail ? 'This work' : 'Whole plan';
    railRangeButton.title = wholePlanOnRail ? 'Show only the days of this work on the timeline' : 'Show every day of the plan on the timeline';
    assistantButton.setAttribute('aria-pressed', String(context.panel.isOpen() && context.panel.tab() === 'assistant'));
    directions.textContent = inWork ? `${WORK_DIRECTIONS} · Esc for the ${fromChart ? 'chart' : 'board'}` : BOARD_DIRECTIONS;
    legend.replaceChildren(...legendFor());
    renderNav();
  }

  /** The trail of where you are, and each way on from here, drawn from the scene itself. */
  function renderNav(): void {
    const parts: HTMLElement[] = [];
    const go = (to: SiteScene<TaskModel>): void => goTo(to);
    const trail = document.createElement('ol');
    trail.className = 'fx3d-trail';
    for (const { label, to } of trailOf(scene, navPlan)) {
      const item = document.createElement('li');
      if (to) {
        const link = document.createElement('button');
        link.type = 'button';
        link.textContent = label;
        link.addEventListener('click', () => go(to));
        item.append(link);
      } else {
        item.textContent = label;
        item.setAttribute('aria-current', 'location');
      }
      trail.append(item);
    }
    parts.push(trail);
    const steps = stepsFrom(scene, navPlan).filter((step) => step.role !== 'up');
    if (steps.length > 0) {
      const onward = document.createElement('div');
      onward.className = 'fx3d-onward';
      for (const step of steps) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = step.role === 'next' || step.role === 'down' ? 'button is-primary is-sm' : 'button is-sm';
        const arrow = document.createElement('i');
        arrow.className = step.role === 'previous' ? 'fa fa-arrow-left' : 'fa fa-arrow-right';
        const label = document.createElement('span');
        label.textContent = step.label;
        if (step.role === 'previous') button.append(arrow, label);
        else button.append(label, arrow);
        button.addEventListener('click', () => go(step.to));
        onward.append(button);
      }
      parts.push(onward);
    }
    nav.replaceChildren(...parts);
  }

  function legendFor(): (HTMLElement | string)[] {
    if (focus) {
      const work = cssColorText(focus.barColor);
      const idle = tokenColor('--warning-fill');
      if (lens === 'money') return [swatch(work, 'Solid: work planned to have started by this date'), swatch(tokenColor('--gray-300'), 'Pale: not yet'), swatch(idle, 'Machine booked, no work planned')];
      if (lens === 'crew') return ['Each figure is one person, with the hard hat of their firm. Solid ones are planned on site on this date, pale ones later.'];
      if (lens === 'issues') return [focus.site.issues.length > 0 ? 'Lit while it is happening. Click a label to go to that date.' : 'Nothing here needs attention.'];
      if (modelShows === 'reported') return [focus.site.facts.percent > 0 ? 'Solid: reported done. Pale: the rest of the work.' : 'Nothing reported yet, so all of it is pale.'];
      return [...(rentalUse(focus.site.days).idle > 0 ? [swatch(idle, 'Machine booked, no work planned')] : []), 'Click a day to go there.'];
    }
    if (lens === 'money') {
      return [swatch(tokenColor('--gray-700'), 'Solid: work planned to have started by this date'), swatch(tokenColor('--gray-300'), 'Pale: not yet'), swatch(tokenColor('--warning-fill'), 'Machine booked, no work planned'), 'Each column is a job, each color who it pays, and the ring is its budget.'];
    }
    if (lens === 'crew') return ['Each firm has its logo and headcount on the floor, and one figure for each person. Solid ones are planned on site on this date.'];
    if (lens === 'issues') {
      const count = pieces.filter((piece) => piece.site.issues.length > 0).length;
      const knockOn = pieces.filter((piece) => piece.site.knockOnDays > 0).length;
      if (count === 0) return ['Nothing on the plan needs attention.'];
      return [`${count} ${count === 1 ? 'place' : 'places'} to act, lit while it is happening. Click a label to go to that date.${knockOn > 0 ? ` ${knockOn} more late only because of the work before them.` : ''}`];
    }
    const phase = pieces[0] ? cssColorText(pieces[0].barColor) : tokenColor('--gray-600');
    if (showing.crew) {
      const firms = new Map(pieces.flatMap((piece) => piece.site.facts.crews.slice(0, 1).map((crew) => [crew.name, crew.color] as const)));
      return [...firms].map(([name, color]) => swatch(color, name));
    }
    return [swatch(tokenColor('--warning-fill'), 'Machine booked, no work planned'), swatch(phase, 'Plot edge: the work, in its phase color'), swatch(tokenColor('--gray-800'), 'Heavy edge: critical path'), 'One tick a day. Double-click a plot to go in.'];
  }

  function setModelShows(next: typeof modelShows): void {
    if (next === modelShows) return;
    modelShows = next;
    syncBar();
    if (focus) refreshRoom(focus);
    context.wake();
  }

  function setLens(next: Lens): void {
    if (next === 'money' && !look().canViewCosts) return;
    if (next === lens) return;
    const crewAsked = next === 'crew' || lens === 'crew';
    lens = next;
    if (focus && crewAsked) {
      // They stand somewhere else for this question: they rise again there, as anything does on a change of lens.
      seatInRoom(focus);
      focus.u.crew = 0;
    }
    shadowsMoving = 1;
    lensChanging = !reducedMotion;
    if (reducedMotion) refreshPlates();
    syncBar();
    writeDiary();
    if (focus) refreshRoom(focus);
    context.wake();
  }

  function setDate(value: number): void {
    now = Math.min(span.end, Math.max(span.start, value));
    rail?.show(now);
    flowline?.show(now);
    const day = dayKey(now);
    if (day !== lastDay) {
      const forward = day > lastDay;
      lastDay = day;
      for (const piece of pieces) piece.progress = progressAt(piece.site.facts, now);
      if (forward && playing && focus) popIdleDay(focus);
      if (pickedAt !== null && !picking && day !== dayKey(pickedAt)) pickedAt = null;
      writeDiary();
      refreshPlates();
      if (focus) refreshRoom(focus);
    }
    shadowsMoving = 1;
    context.wake();
  }

  /** Words that go up from a day's tile and are gone. */
  function popFromTile(piece: Piece, at: number, text: string, tone: string): void {
    const x = piece.stage?.track.tileX(at);
    if (x === null || x === undefined) return;
    const [, d] = roomSize(piece.plot);
    const { width, height } = context.size();
    tagPoint.set(piece.group.position.x + x, piece.group.position.y - d / 2 - 24, 8).project(camera);
    const pop = document.createElement('span');
    pop.className = 'fx3d-tag fx3d-pop';
    pop.dataset.tone = tone;
    pop.textContent = text;
    pop.style.left = `${((tagPoint.x + 1) / 2) * width}px`;
    pop.style.top = `${((1 - tagPoint.y) / 2) * height}px`;
    pop.addEventListener('animationend', () => pop.remove());
    roomLayer.append(pop);
  }

  /** Playing through an idle day, what it cost goes up from its tile: this is the moment the money leaves. */
  function popIdleDay(piece: Piece): void {
    if (!piece.stage || reducedMotion || piece.roomU < 0.6) return;
    const tile = piece.site.days.find((item) => item.kind === 'idle' && item.costMinor > 0 && now >= item.at && now < item.at + DAY_MS);
    if (tile) popFromTile(piece, tile.at, spentWords(wholeMoney(tile.costMinor, look().currency)), 'caution');
  }

  /** The last moment on a work's own track: inside its last day, whichever comes last of the work and the rental. */
  const lastMomentOf = (piece: Piece): number => {
    const days = piece.site.days;
    const last = days[days.length - 1];
    return last ? last.at + DAY_MS * 0.9 : piece.site.facts.rulerEnd.getTime();
  };

  /** Play means what is in front of you: the whole plan on the board, this work's own days in its room. */
  function togglePlay(): void {
    if (playing) {
      pause();
      return;
    }
    setModelShows('planned');
    if (focus) {
      const { rulerStart } = focus.site.facts;
      if (now < rulerStart.getTime() || now >= lastMomentOf(focus) - DAY_MS / 2) setDate(rulerStart.getTime());
      play(lastMomentOf(focus), SECONDS_PER_DAY_IN_WORK);
    } else {
      play();
    }
  }

  function play(until = span.end, secondsPerDay = SECONDS_PER_DAY): void {
    stopGlide?.();
    let from = now;
    if (from >= until - DAY_MS) from = span.start;
    playing = true;
    syncBar();
    const days = (until - from) / DAY_MS;
    const controls = animate(from, until, {
      duration: days * secondsPerDay,
      ease: 'linear',
      onUpdate: (value: number) => setDate(value),
      onComplete: () => {
        playing = false;
        syncBar();
      },
    });
    stopPlay = () => controls.stop();
  }

  function pause(): void {
    stopPlay?.();
    stopPlay = undefined;
    if (playing) {
      playing = false;
      syncBar();
    }
  }

  // ---------------------------------------------------------------------------------------
  // The site diary: what this date means, in words
  // ---------------------------------------------------------------------------------------

  /** What a machine has cost so far by waiting: the rate for each idle day gone. */
  function idleSoFar(site: SiteTask): number {
    return site.idleCostMinor > 0 ? idleCostBy(site.days, now) : 0;
  }

  /**
   * How much of a cost line has gone out by the date, as far as the plan can say: a machine costs its rate by the day,
   * idle or working. A crew's share has no days of its own, and work needn't go evenly, so it counts whole once its work has begun.
   */
  function lineShare(piece: Piece, line: CostLine): number {
    if (line.kind === 'idle') return piece.site.idleCostMinor > 0 ? idleSoFar(piece.site) / piece.site.idleCostMinor : 0;
    if (line.kind === 'machine') return workDaysBegun(piece.site.days, now);
    return piece.progress.state === 'ahead' ? 0 : 1;
  }

  /** The same for a job's money apart from its idle days. */
  function workShare(piece: Piece): number {
    const lines = piece.site.costs.filter((line) => line.kind !== 'idle');
    const total = lines.reduce((sum, line) => sum + line.minor, 0);
    return total > 0 ? lines.reduce((sum, line) => sum + line.minor * lineShare(piece, line), 0) / total : 0;
  }

  const paintOf = (color: string): string => (color.startsWith('var(') ? tokenColor(color.slice(4, -1)) : color);

  const nameOfPiece = (piece: Piece): string => `${piece.site.facts.wbs ? `${piece.site.facts.wbs} ` : ''}${piece.site.facts.name}`;

  /** The chart's rows: a bar for each phase with a segment for each job, or a bar for each firm. */
  function moneyRows(): MoneyRow[] {
    if (moneyBy === 'crew') {
      return rowsByFirm(pieces.map((piece) => ({ work: piece.site.record as unknown, title: nameOfPiece(piece), lines: piece.site.costs.map((line) => ({ ...line, color: paintOf(line.color) })), share: (line: CostLine) => lineShare(piece, line) })));
    }
    return phasePlates.map((phase) => ({
      label: phase.name,
      // A job is one segment in its phase's color, and what its machine costs standing idle is one in amber.
      segments: phase.tasks.flatMap((piece) => {
        const idle = piece.site.costs.find((line) => line.kind === 'idle');
        const rest = piece.site.costs.reduce((sum, line) => (line.kind === 'idle' ? sum : sum + line.minor), 0);
        return [
          ...(rest > 0 ? [{ key: piece.site.record as unknown, title: nameOfPiece(piece), minor: rest, share: workShare(piece), color: cssColorText(piece.barColor) }] : []),
          ...(idle ? [{ key: piece.site.record as unknown, title: `${nameOfPiece(piece)}, machine standing idle`, minor: idle.minor, share: lineShare(piece, idle), color: paintOf(idle.color) }] : []),
        ];
      }),
    }));
  }

  function moneySection(): HTMLElement {
    const { currency } = look();
    const block = document.createElement('div');
    block.className = 'fx3d-diary-part';
    const head = document.createElement('div');
    head.className = 'fx3d-money-head';
    const title = document.createElement('small');
    title.textContent = 'Where the money goes';
    const choice = document.createElement('div');
    choice.className = 'segmented is-sm';
    for (const [id, label] of [['job', 'By job'], ['crew', 'By crew']] as const) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = label;
      option.setAttribute('aria-pressed', String(moneyBy === id));
      option.addEventListener('click', () => {
        moneyBy = id;
        writeDiary();
      });
      choice.append(option);
    }
    head.append(title, choice);
    block.append(
      head,
      createMoneyChart({
        rows: moneyRows(),
        money: (minor) => compactMoney(minor, currency),
        hint: 'Point at a segment to see what it is. Click to go in.',
        onHover: (key) => {
          railHover = key;
          context.wake();
        },
        onOpen: (key) => goTo({ kind: 'work', work: key as TaskModel }),
      }),
    );
    return block;
  }

  function writeDiary(): void {
    diary.classList.toggle('is-wide', lens === 'money' && look().canViewCosts && !fall);
    if (scene.kind === 'work' && focus) {
      writeWorkPanel(focus);
      return;
    }
    const { currency, canViewCosts } = look();
    const section = (label: string, ...lines: (string | HTMLElement)[]): HTMLElement => {
      const block = document.createElement('div');
      block.className = 'fx3d-diary-part';
      const small = document.createElement('small');
      small.textContent = label;
      block.append(small);
      for (const line of lines) {
        const item = document.createElement('p');
        item.append(line);
        block.append(item);
      }
      return block;
    };
    const parts: HTMLElement[] = [];
    const head = document.createElement('h2');
    head.textContent = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    const dayOfPlan = Math.max(1, Math.ceil((now - span.start) / DAY_MS));
    const totalDays = Math.max(1, Math.round((span.end - span.start) / DAY_MS));
    const under = document.createElement('p');
    under.className = 'fx3d-diary-sub';
    under.textContent = `Plan day ${dayOfPlan} of ${totalDays}`;
    parts.push(head, under);

    const chartFirst = canViewCosts && lens === 'money';
    if (chartFirst) parts.push(moneySection());
    const active = pieces.filter((piece) => piece.progress.state === 'active');
    const lines = active.map((piece) => {
      const { progress, site } = piece;
      const wbs = site.facts.wbs ? `${site.facts.wbs} ` : '';
      return `${wbs}${site.facts.name}: ${progress.day > 0 ? `day ${progress.day} of ${progress.of}` : 'day off'}`;
    });
    if (!chartFirst) parts.push(section('Planned for this date', ...(lines.length > 0 ? lines : ['Nothing on this date.'])));

    if (active.length > 0 && !chartFirst) {
      const people = [...new Set(active.flatMap((piece) => piece.site.facts.crews.map((crew) => crew.name)))];
      if (people.length > 0) parts.push(section('Crew planned on site', people.join(', ')));
    }

    const onRent = pieces.filter((piece) => piece.site.facts.machines.length > 0 && now >= piece.site.facts.rulerStart.getTime() && now < piece.site.facts.rulerEnd.getTime());
    if (onRent.length > 0 && !chartFirst) {
      parts.push(
        section(
          'Machines booked',
          ...onRent.map((piece) => {
            const { facts } = piece.site;
            const line = document.createElement('span');
            const idleNow = now < facts.start.getTime() || now >= facts.end.getTime();
            line.textContent = `${facts.machine ?? 'Machine'}: ${idleNow ? 'booked, no work planned' : 'booked, work planned'}`;
            if (idleNow) line.className = 'is-caution';
            return line;
          }),
        ),
      );
    }

    if (canViewCosts) {
      const forecast = pieces.reduce((sum, piece) => sum + (piece.site.money?.expected ?? 0), 0);
      const started = pieces.reduce((sum, piece) => sum + (piece.progress.state === 'ahead' ? 0 : (piece.site.money?.expected ?? 0)), 0);
      const idle = pieces.reduce((sum, piece) => sum + idleSoFar(piece.site), 0);
      const moneyLines: (string | HTMLElement)[] = [`${wholeMoney(started, currency)} of ${wholeMoney(forecast, currency)} in work planned to have started`];
      if (idle > 0) {
        const line = document.createElement('span');
        line.className = 'is-caution';
        line.textContent = `${wholeMoney(idle, currency)} booked for idle machines`;
        moneyLines.push(line);
      }
      parts.push(section('Money by this date', ...moneyLines));

      const paid = pieces.filter((piece) => piece.site.payout.state === 'paid');
      const moving = pieces.filter((piece) => piece.site.payout.state === 'moving');
      const ready = pieces.filter((piece) => piece.site.payout.state === 'ready');
      const failed = pieces.filter((piece) => piece.site.payout.state === 'failed');
      const total = (list: readonly Piece[]) => wholeMoney(list.reduce((sum, piece) => sum + (piece.site.payout.amountMinor ?? 0), 0), currency);
      const logo = document.createElement('img');
      logo.src = '/paypal/paypal-wordmark.svg';
      logo.alt = 'PayPal';
      logo.className = 'fx3d-paypal-logo';
      const payLines: string[] = [];
      if (paid.length > 0) payLines.push(`${total(paid)} paid, ${paid.length} ${paid.length === 1 ? 'supplier' : 'suppliers'}`);
      if (moving.length > 0) payLines.push(`${total(moving)} on its way`);
      if (ready.length > 0) payLines.push(`${total(ready)} ready to pay`);
      if (failed.length > 0) payLines.push(`${failed.length} ${failed.length === 1 ? 'payment' : 'payments'} failed`);
      const payBlock = section('', ...(payLines.length > 0 ? payLines : ['No supplier payments yet.']));
      payBlock.querySelector('small')?.replaceChildren(logo);
      parts.push(payBlock);
    }

    const happening = pieces.flatMap((piece) => piece.site.issues.filter((issue) => now >= issue.from && now < issue.to));
    if (happening.length > 0) {
      parts.push(
        section(
          'Needs attention on this date',
          ...[...new Set(happening.map((issue) => issue.text))].map((text) => {
            const line = document.createElement('span');
            line.className = happening.find((issue) => issue.text === text)?.tone === 'danger' ? 'is-danger' : 'is-caution';
            line.textContent = text;
            return line;
          }),
        ),
      );
    }

    const next = pieces.filter((piece) => piece.site.facts.start.getTime() > now).sort((a, b) => a.site.facts.start.getTime() - b.site.facts.start.getTime())[0];
    if (next && !chartFirst) parts.push(section('Next', `${next.site.facts.name}, ${next.site.facts.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`));
    diary.replaceChildren(...parts);
  }

  /** How much of a rental is being used: what an equipment telematics screen would lead with. */
  function rentalLine(site: SiteTask): string | null {
    const use = rentalUse(site.days);
    if (site.facts.rulerStart >= site.facts.start && site.facts.rulerEnd <= site.facts.end) return null;
    return `Work planned on ${use.work} of ${use.booked} booked days`;
  }

  /** Everything the plan says about one piece of work, on this date. */
  function factRows(piece: Piece): HTMLElement[] {
    const { site, progress } = piece;
    const { facts } = site;
    const { currency } = look();
    const line = (label: string, value: string) => {
      const item = document.createElement('div');
      const small = document.createElement('small');
      small.textContent = label;
      const text = document.createElement('span');
      text.textContent = value;
      item.append(small, text);
      return item;
    };
    const state = progress.state === 'ahead' ? 'Not planned to start by this date' : progress.state === 'done' ? 'Planned to be done by this date' : progress.day > 0 ? `Planned day ${progress.day} of ${progress.of}` : 'Planned day off';
    const before = ((site.record.predecessors ?? []) as unknown as { fromEvent?: TaskModel | null }[]).map((dep) => dep.fromEvent?.name).filter(Boolean);
    const after = ((site.record.successors ?? []) as unknown as { toEvent?: TaskModel | null }[]).map((dep) => dep.toEvent?.name).filter(Boolean);
    return [
      line('Status', state),
      line('Reported', facts.percent > 0 ? `${Math.round(facts.percent)}% done` : 'Nothing yet'),
      line('Dates', `${shortDate(facts.start)} to ${shortDate(new Date(facts.end.getTime() - 1))}`),
      line('Crew', facts.crews.map((crew) => crew.name).join(', ') || 'None assigned'),
      ...(facts.machineNames.length > 0 ? [line('Machine', facts.machineNames.join(', '))] : []),
      ...(rentalLine(site) ? [line('Rental', rentalLine(site)!)] : []),
      ...(site.slackDays > 0 ? [line('Slack', `${site.slackDays} ${site.slackDays === 1 ? 'day' : 'days'} before it moves the handover`)] : []),
      ...(before.length > 0 ? [line('Waits for', before.join(', '))] : []),
      ...(after.length > 0 ? [line('Then', after.join(', '))] : []),
      ...(site.critical ? [line('Critical path', 'A day lost here moves the handover')] : []),
      ...(facts.constraint ? [line('Constraint', `${facts.constraint.label} ${shortDate(facts.constraint.date)}`)] : []),
      ...(facts.deadline ? [line('Deadline', shortDate(facts.deadline))] : []),
      ...(site.money ? [line('Budget / forecast', `${wholeMoney(site.money.budget, currency)} / ${wholeMoney(site.money.expected, currency)}`), line('Spent / paid', `${wholeMoney(site.money.spent, currency)} / ${wholeMoney(site.money.paid, currency)}`)] : []),
      // Paid ahead of the work is an issue, and says so in its own pill.
      ...(site.payCheck && site.payCheck.aheadMinor <= 0 ? [line('Payment', payCheckWords(site.payCheck, (minor) => wholeMoney(minor, currency)))] : []),
      ...(site.payout.state !== 'none' ? [line('PayPal', `${site.payout.status ?? ''}${site.payout.amountMinor ? ` · ${wholeMoney(site.payout.amountMinor, currency)}` : ''}`)] : []),
      ...(site.knockOnDays > 0 ? [line('Late', `${site.knockOnDays} days, because of the work before it`)] : []),
    ];
  }

  function issuePills(piece: Piece): HTMLElement[] {
    return piece.site.issues.map((issue) => {
      const pill = document.createElement('p');
      pill.className = issue.tone === 'danger' ? 'pill is-danger' : 'pill is-warning';
      pill.textContent = issue.text;
      return pill;
    });
  }

  /** What can be done from here about this work: each leads somewhere that offers a way back. */
  function workActions(piece: Piece, enter: boolean): HTMLElement {
    const { site } = piece;
    const actions = document.createElement('div');
    actions.className = 'fx3d-card-actions';
    const button = (label: string, primary: boolean, run: () => void): HTMLButtonElement => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = primary ? 'button is-primary is-sm' : 'button is-sm';
      item.textContent = label;
      item.addEventListener('click', run);
      return item;
    };
    const { record } = site;
    // A payment ready for review is the one main action here; going in steps back beside it.
    const payable = site.payout.state === 'ready' && Boolean(context.openPayment);
    if (enter) actions.append(button('Go in', !payable, () => goTo({ kind: 'work', work: record })));
    actions.append(button('Edit task', false, () => editWork(record)));
    if (site.payout.state !== 'none' && context.openPayment) {
      const pay = button(payable ? 'Review payment' : 'See the payment', payable, () => goToPayment(record));
      if (payable) pay.classList.add('fx3d-pay');
      actions.append(pay);
    }
    // What to do about idle days is a question for the assistant, here in the room.
    if (site.idleCostMinor > 0 && context.panel && site.payout.state === 'none') actions.append(button(`Ask ${ASSISTANT_NAME}`, false, () => context.panel.open('assistant')));
    return actions;
  }

  function writeWorkPanel(piece: Piece): void {
    const { facts } = piece.site;
    const head = document.createElement('h2');
    head.textContent = `${facts.wbs ? `${facts.wbs} ` : ''}${facts.name}`;
    const under = document.createElement('p');
    under.className = 'fx3d-diary-sub';
    under.textContent = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    const rows = document.createElement('div');
    rows.className = 'fx3d-facts';
    rows.append(...factRows(piece));
    const { currency } = look();
    const costs = lens === 'money' && piece.site.costs.length > 0
      ? createMoneyChart({
          rows: rowsByFirm([{ work: piece.site.record as unknown, title: facts.name, lines: piece.site.costs.map((line) => ({ ...line, color: paintOf(line.color) })), share: (line) => lineShare(piece, line) }]),
          money: (minor) => compactMoney(minor, currency),
          hint: 'What this work costs, and who it pays.',
          onHover: () => undefined,
        })
      : null;
    diary.replaceChildren(head, under, ...(costs ? [costs] : []), rows, ...issuePills(piece), workActions(piece, false));
  }

  // ---------------------------------------------------------------------------------------
  // Moving between scenes
  // ---------------------------------------------------------------------------------------

  /** A work's scale model, with its finished form in pale, standing in `work`. */
  function addModel(site: SiteTask, work: Group, ghostMaterial: MeshStandardMaterial): Pick<Piece, 'kit' | 'ghosts' | 'ghostKit'> {
    const kit = buildKit(m, site.facts, context.props());
    // The kit's stand-in people go; real ones walk the plot when their work is on.
    const people: Object3D[] = [];
    kit.root.traverse((child) => {
      if (child.userData.person) people.push(child);
    });
    for (const person of people) person.removeFromParent();
    kit.root.scale.setScalar(MODEL_SCALE);
    work.add(kit.root);
    const ghosts = ghostEntries(kit.root);
    // Its finished form in pale, without the machines (they are real as soon as they are on site).
    kit.update({ work: 1, idle: false, time: 0 });
    // It never moves, so it is one mesh, however many parts the model has.
    const finished = kit.root.clone(true);
    const machines: Object3D[] = [];
    finished.traverse((child) => {
      if (child.userData.machine) machines.push(child);
    });
    for (const machine of machines) machine.removeFromParent();
    const ghostKit = new Group();
    ghostKit.add(bakeInto(finished, ghostMaterial));
    ghostKit.scale.setScalar(MODEL_SCALE);
    work.add(ghostKit);
    skipWhileHidden(kit.root);
    return { kit, ghosts, ghostKit };
  }

  /** A cutaway room around one plot: two walls rise from its back edges, carrying its name, and it is a scene. */
  function makeRoom(piece: Piece): Group {
    // A large plan's board leaves its models out, but a room always has one: it is what a review looks at.
    if (!piece.kit) {
      Object.assign(piece, addModel(piece.site, piece.work, piece.ghostMaterial));
      piece.roomOnlyModel = true;
    }
    const { facts } = piece.site;
    const [w, d] = roomSize(piece.plot);
    const wall = roomHeightOf(piece);
    const room = new Group();
    room.position.z = PLINTH;
    const wallMaterial = new MeshStandardMaterial({ color: piece.barColor.clone().lerp(new Color('#ffffff'), 0.84), roughness: 0.86 });
    const skirtMaterial = new MeshStandardMaterial({ color: piece.barColor, roughness: 0.6 });
    extraMaterials.push(wallMaterial, skirtMaterial);
    const thick = 7;
    const back = solid(new BoxGeometry(w + thick, thick, wall).translate(0, 0, wall / 2), wallMaterial, thick / 2, d / 2 + thick / 2, 0);
    const side = solid(new BoxGeometry(thick, d, wall).translate(0, 0, wall / 2), wallMaterial, w / 2 + thick / 2, 0, 0);
    const backSkirt = solid(new BoxGeometry(w, 2, 14).translate(0, 0, 7), skirtMaterial, 0, d / 2 - 1, 0);
    const sideSkirt = solid(new BoxGeometry(2, d, 14).translate(0, 0, 7), skirtMaterial, w / 2 - 1, 0, 0);
    const backWall = new Group();
    const sideWall = new Group();
    backWall.add(back, backSkirt);
    sideWall.add(side, sideSkirt);
    room.add(backWall, sideWall);
    // The ground of the job, inside a border in the bar's own color. It stays just over the plot as the room rises.
    const floor = new Mesh(new PlaneGeometry(w - 16, d - 16), m.gravel);
    floor.receiveShadow = true;
    floor.position.z = PLINTH + 0.25;
    floor.scale.setScalar(0.001);
    floor.visible = false;
    piece.group.add(floor);

    // Its name on the wall, as a drawing's title block is lettered.
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const paint = canvas.getContext('2d')!;
    const letteringMap = Object.assign(new CanvasTexture(canvas), { colorSpace: SRGBColorSpace, anisotropy: 8 });
    // The firms on the job, at the end of the name, as a contractor's board has them.
    const logos = new Map<number, HTMLImageElement>();
    const paintTitle = (): void => {
      const now = piece.site.facts;
      paint.clearRect(0, 0, canvas.width, canvas.height);
      paint.fillStyle = tokenColor('--ink');
      paint.textBaseline = 'top';
      paint.font = `760 62px "Archivo Variable", system-ui, sans-serif`;
      paint.fillText(`${now.wbs ? `${now.wbs}  ` : ''}${now.name}`, 8, 8, 1000);
      paint.fillStyle = tokenColor('--ink-soft');
      paint.font = `480 40px "Archivo Variable", system-ui, sans-serif`;
      paint.fillText(`${shortDate(now.start)} to ${shortDate(new Date(now.end.getTime() - 1))}`, 8, 92, 1000);
      for (const [index, logo] of logos) paint.drawImage(logo, 1024 - 150 * (index + 1), 100, 140, 140);
      letteringMap.needsUpdate = true;
    };
    paintTitle();
    facts.crews.filter((crew) => crew.image).slice(0, 3).forEach((crew, index) => {
      const logo = new Image();
      logo.onload = () => {
        logos.set(index, logo);
        paintTitle();
      };
      logo.src = crew.image!;
    });
    const lettering = new MeshBasicMaterial({ map: letteringMap, transparent: true, toneMapped: false, depthWrite: false });
    extraMaterials.push(lettering);
    const sign = new Mesh(new PlaneGeometry(w * 0.86, w * 0.86 * 0.25), lettering);
    sign.rotation.x = Math.PI / 2;
    sign.position.set(-w * 0.04, d / 2 - 1.5, wall - w * 0.11);
    backWall.add(sign);

    piece.stage = makeStage(piece, room, backWall, sideWall, floor, w, d, paintTitle);
    room.scale.z = 0.001;
    room.visible = false;
    piece.group.add(room);
    refreshRoom(piece);
    return room;
  }

  /**
   * Where each firm is in a room, in the band along the front of its floor: a share of the width by headcount, its
   * mark on the ground, and its people standing right beside it.
   */
  function roomSpots(piece: Piece): { mark: { x: number; y: number; w: number; d: number }; people: { x: number; y: number; w: number; d: number } }[] {
    const [w, d] = roomSize(piece.plot);
    const crews = piece.site.facts.crews;
    const y = -d / 2 + 42;
    return crewZones(crews.map((crew) => crew.people), w - 28, 150).map((zone) => {
      const markW = Math.min(150, zone.w * 0.54);
      const left = zone.x - zone.w / 2;
      const standFrom = left + markW + 8;
      return { mark: { x: left + markW / 2, y, w: markW, d: 44 }, people: { x: (standFrom + zone.x + zone.w / 2) / 2, y: y + 2, w: Math.max(26, zone.x + zone.w / 2 - standFrom - 6), d: 62 } };
    });
  }

  /** A work's people in its room: beside their firm's mark when the crew is the question, otherwise at the work. */
  function seatInRoom(piece: Piece): void {
    if (lens !== 'crew') {
      const [w, d] = roomSize(piece.plot);
      const jobs = roomJobs(
        piece.workers.map((worker) => worker.walks),
        { work: workBounds(piece), stock: [...(piece.stage?.set.stock ?? []), ...kitSpots(piece, 'stock')], machine: machineSpot(piece) },
      );
      piece.workers.forEach((worker, index) => {
        worker.roam({ x: -w * 0.08, y: -d * 0.2, w: w * 0.72, d: d * 0.5 });
        worker.follow(jobs[index] ?? []);
      });
      return;
    }
    const zones = roomSpots(piece);
    zones.forEach(({ people }, crewIndex) => {
      const own = piece.spots.filter((spot) => spot.crew === crewIndex);
      standingSpots(own.length, people).forEach((at, index) => own[index]?.worker.standAt(at.x, at.y, people));
    });
  }

  function seatOnBoard(piece: Piece): void {
    for (const spot of piece.spots) spot.worker.standAt(spot.x, spot.y, spot.area);
  }

  /** Walls as tall as the work needs: a crane needs its height, and a room with less in it gets more sky. */
  function roomHeightOf(piece: Piece): number {
    return piece.site.facts.machines.includes('crane') ? ROOM_HEIGHT : ROOM_HEIGHT_LOW;
  }

  const modelGrowth = (piece: Piece): number => (piece.site.facts.machines.includes('crane') ? 1 : ROOM_MODEL_GROWTH);

  /** Where the work itself stands in its room: the finished model without its machines, or the middle of the floor. */
  function workBounds(piece: Piece): { x: number; y: number; w: number; d: number } {
    const [w, d] = roomSize(piece.plot);
    const baked = piece.ghostKit?.children[0] as Mesh | undefined;
    if (!baked?.geometry) return { x: 0, y: 0, w: w * 0.4, d: d * 0.35 };
    baked.geometry.computeBoundingBox();
    const box3 = baked.geometry.boundingBox!;
    const scale = MODEL_SCALE * modelGrowth(piece);
    return {
      x: ((box3.min.x + box3.max.x) / 2) * scale,
      y: ((box3.min.y + box3.max.y) / 2) * scale,
      w: Math.min(w - 60, (box3.max.x - box3.min.x) * scale),
      d: Math.min(d - 60, (box3.max.y - box3.min.y) * scale),
    };
  }

  /** Where the parts of a model marked this way stand, in the plot's space. */
  function kitSpots(piece: Piece, mark: 'machine' | 'stock'): Vector3[] {
    const nodes: Object3D[] = [];
    piece.kit?.root.traverse((child) => {
      if (child.userData[mark]) nodes.push(child);
    });
    if (nodes.length === 0) return [];
    piece.group.updateWorldMatrix(true, false);
    const growth = modelGrowth(piece) / (piece.kit!.root.scale.x / MODEL_SCALE);
    return nodes.map((node) => {
      const at = node.getWorldPosition(new Vector3());
      return new Vector3((at.x - piece.group.position.x) * growth, (at.y - piece.group.position.y) * growth, 0);
    });
  }

  /** Where a machine stands in its model, or null if the model has none. */
  function machineSpot(piece: Piece): Vector3 | null {
    return kitSpots(piece, 'machine')[0] ?? null;
  }

  function makeStage(piece: Piece, room: Group, backWall: Group, sideWall: Group, floor: Mesh, w: number, d: number, paintTitle: () => void): RoomStage {
    const { site } = piece;
    const { facts } = site;
    const { currency, canViewCosts } = look();
    const barText = cssColorText(piece.barColor);
    const money = (minor: number): string => wholeMoney(minor, currency);

    const set = dressRoom(m, facts, w, d, piece.plot.x * 0.13 + piece.plot.y * 0.07, context.props());
    room.add(set.group);

    // Every day of the job along the front of the room.
    const track = createDayTrack(site.days, w, -d / 2 - 24, { bar: barText, idle: tokenColor('--warning-fill'), ink: tokenColor('--ink'), soft: tokenColor('--ink-soft'), paper: tokenColor('--surface'), off: tokenColor('--gray-300') }, money);
    track.group.position.z = -PLINTH + 0.3;
    room.add(track.group);

    // What the side wall says on this date, in this lens. Its text runs from the back corner toward the camera.
    const boardWidth = d * 0.88;
    const wall = roomHeightOf(piece);
    const board = createWallBoard(boardWidth, wall - 14, { ink: tokenColor('--ink'), soft: tokenColor('--ink-soft'), track: tokenColor('--gray-200'), danger: tokenColor('--danger'), caution: tokenColor('--warning-fill') }, 1024, 1.55);
    board.mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0)));
    board.mesh.position.set(w / 2 - 1.2, 0, wall - 6 - (wall - 14) / 2);
    sideWall.add(board.mesh);

    const spot = machineSpot(piece);

    // Money, standing in the room: one slim stacked bar by the back wall, with each line named beside it.
    let moneyStage: RoomStage['money'] = null;
    const labels: RoomLabel[] = [];
    const label = (lenses: readonly Lens[], at: () => Vector3 | null, refresh: RoomLabel['refresh'], onClick?: () => void): void => {
      const element = document.createElement('span');
      element.className = 'fx3d-tag';
      element.hidden = true;
      if (onClick) {
        element.style.pointerEvents = 'auto';
        element.addEventListener('click', onClick);
      }
      roomLayer.append(element);
      labels.push({ element, at, lenses, refresh });
    };

    // The same column, large, in the middle of the room, with each line named beside its layer.
    const columnAt = { x: -w * 0.17, y: d * 0.1 };
    if (site.money && canViewCosts && site.costs.length > 0) {
      const bars = stackBars(site.costs, 128 / Math.max(site.money.expected, site.money.budget, 1), 76, 62, piece.barColor);
      bars.group.position.set(columnAt.x, columnAt.y, 0.6);
      room.add(bars.group);
      moneyStage = { bars, u: 0 };
      for (const segment of bars.segments) {
        const middle = (): number => segment.fill.position.z + segment.fill.scale.z / 2;
        label(['money'], () => new Vector3(columnAt.x + 62, columnAt.y - 30, PLINTH + 0.6 + middle()), () => (segment.line.minor > 0 ? { text: `${segment.line.who}${segment.line.kind === 'idle' ? ', idle' : ''} ${money(segment.line.minor)}`, tone: segment.line.kind === 'idle' ? 'caution' : '' } : null));
      }
      const words: Record<string, string> = { paid: 'Paid by PayPal', moving: 'PayPal is processing', ready: 'Ready to pay', failed: 'Payment failed' };
      label(['money'], () => new Vector3(columnAt.x, columnAt.y, PLINTH + bars.top + 20), () => {
        const { state } = piece.site.payout;
        return words[state] ? { text: words[state]!, tone: state === 'ready' ? 'ready' : state === 'failed' ? 'danger' : 'paypal' } : null;
      });
    }

    // Who is here: each firm's logo and headcount on the ground, along the front of the room.
    let crewMarks: Group | null = null;
    if (facts.crews.length > 0) {
      crewMarks = new Group();
      roomSpots(piece).forEach(({ mark }, index) => {
        const sign = crewMarkMesh(facts.crews[index]!, mark.w, mark.d, mark.x, mark.y);
        // Leaning back like a site sign, or at this angle the logo would be a sliver.
        sign.rotation.x = 0.72;
        sign.position.z = (Math.sin(0.72) * mark.d) / 2 + 1;
        crewMarks!.add(sign);
      });
      crewMarks.position.z = 0.6;
      crewMarks.visible = false;
      room.add(crewMarks);
    }

    // Issues, standing where they happen.
    const pins: RoomStage['pins'] = [];
    const standIssues = (): void => {
      // Those of before go, with their labels: an issue that was fixed is simply not there any more.
      for (const pin of pins.splice(0)) {
        pin.group.removeFromParent();
        // The post's material is shared with the rest of the site, so only what is the pin's own goes.
        pin.group.traverse((child) => {
          if (child instanceof Mesh) child.geometry.dispose();
        });
        pin.lamp.dispose();
      }
      const gone = new Set(pinLabels.splice(0));
      for (const element of gone) element.remove();
      const kept = labels.filter((item) => !gone.has(item.element));
      labels.length = 0;
      labels.push(...kept);
      piece.site.issues.forEach((issue, index) => {
        const color = cssColor(issue.tone === 'danger' ? tokenColor('--danger') : tokenColor('--warning-fill'));
        const lamp = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, roughness: 0.3 });
        const group = new Group();
        const place = issue.kind === 'idle' && spot ? new Vector3(spot.x + 30, spot.y - 30, 0) : issue.kind === 'over' ? new Vector3(w * 0.3, d * 0.06, 0) : issue.kind === 'booked' ? new Vector3(-w * 0.18, -d * 0.12, 0) : new Vector3(-w * 0.3 + index * 40, d * 0.22, 0);
        group.position.copy(place);
        const height = 96 + index * 18;
        group.add(solid(upright(1.6, height, 8), m.machineDark), solid(new SphereGeometry(8, 18, 14), lamp, 0, 0, height));
        group.visible = false;
        room.add(group);
        pins.push({ group, lamp, from: issue.from, to: issue.to });
        const jump = (): void => {
          pause();
          setDate(middayOf(issue.from));
        };
        label(['issues'], () => new Vector3(place.x, place.y, PLINTH + height + 14), () => ({ text: issue.text, tone: issue.tone, live: now >= issue.from && now < issue.to }), jump);
        pinLabels.push(labels[labels.length - 1]!.element);
      });
    };
    const pinLabels: HTMLElement[] = [];
    standIssues();

    // What the machine's idle days come to: the total, and how much of it by this date while some is still to come.
    label(
      ['work'],
      () => track.idleAnchor(),
      () => {
        const { days, idleCostMinor } = piece.site;
        const idle = days.filter((day) => day.kind === 'idle');
        if (idle.length === 0) return null;
        const gone = idle.filter((day) => now >= day.at).length;
        const partway = gone > 0 && gone < idle.length;
        if (idleCostMinor <= 0) return { text: partway ? `${gone} of ${idle.length} idle days by this date` : `${idle.length} idle ${idle.length === 1 ? 'day' : 'days'}`, tone: 'caution' };
        const total = `Total idle cost ${spentWords(money(idleCostMinor))}`;
        return { text: partway ? `${spentWords(money(idleSoFar(piece.site)))} by this date · ${total}` : total, tone: 'caution' };
      },
    );
    // What a fix made here has saved, over the days that are left, for as long as this stays open.
    label(
      ['work', 'money'],
      () => new Vector3((track.tileX(piece.site.days[0]?.at ?? 0) ?? 0) + w * 0.12, -d / 2 - 24, 26),
      () => (piece.savedMinor > 0 ? { text: `Saved ${money(piece.savedMinor)}: on rent ${shortDate(piece.site.facts.rulerStart)} to ${shortDate(new Date(piece.site.facts.rulerEnd.getTime() - 1))}`, tone: 'good' } : null),
    );
    // The day under the pointer, or the one that was clicked, in words.
    label(
      ['work', 'money', 'crew', 'issues'],
      () => {
        const at = hoveredTile?.at ?? pickedAt;
        const x = at === null ? null : track.tileX(at);
        return x === null ? null : new Vector3(x, -d / 2 - 24, 26);
      },
      () => {
        const at = hoveredTile?.at ?? pickedAt;
        const tile = piece.site.days.find((day) => day.at === at);
        if (!tile) return null;
        return { text: dayWords(tile, piece.site.days, piece.site.facts.machine, money), tone: tile.kind === 'idle' ? 'caution' : '' };
      },
    );

    return { set, track, board, backWall, sideWall, floor, money: moneyStage, crewMarks, pins, pinsU: 0, labels, painted: '', standIssues, paintTitle };
  }

  /** What the wall says in this lens on this date. */
  function roomBoardRows(piece: Piece): BoardRow[] {
    const { site, progress } = piece;
    const { facts } = site;
    const { currency } = look();
    const money = (minor: number): string => wholeMoney(minor, currency);
    if (lens === 'money' && site.money) {
      const rows: BoardRow[] = [{ kind: 'title', text: `${money(site.money.expected)} forecast` }];
      const check = site.payCheck;
      if (site.money.budget > 0) rows.push({ kind: 'line', text: `Budget ${money(site.money.budget)}`, tone: 'quiet' });
      if (check) {
        rows.push(
          { kind: 'bar', label: 'Paid', value: money(check.paidMinor), share: check.paidMinor / Math.max(1, site.money.expected), color: tokenColor('--ink') },
          { kind: 'bar', label: 'Reported done', value: facts.percent > 0 ? `${Math.round(facts.percent)}%, worth ${money(check.earnedMinor)}` : 'Nothing yet', share: facts.percent / 100, color: cssColorText(piece.barColor) },
        );
        if (check.aheadMinor > 0 || check.owedMinor > 0) rows.push({ kind: 'line', text: payCheckWords(check, money), ...(check.aheadMinor > 0 ? { tone: 'caution' as const } : {}) });
      }
      const use = rentalUse(site.days);
      const rate = facts.rig?.rateMinor ?? 0;
      if (rentalLine(site) && rate > 0) rows.push({ kind: 'line', text: `${facts.machine ?? 'Machine'} rental: ${money(rate * use.booked)} for ${use.booked} days, ${use.work} with work planned`, tone: 'quiet' });
      return rows;
    }
    if (lens === 'crew') {
      const state = progress.state === 'active' ? 'Planned on site' : progress.state === 'done' ? 'Planned to be done' : `Planned from ${shortDate(facts.start)}`;
      return [
        { kind: 'title', text: 'Crew' },
        ...facts.crews.map((crew): BoardRow => ({ kind: 'dot', color: crew.color, text: `${crew.name}: ${crew.usual ? 'about ' : ''}${crew.people}`, note: state })),
        ...(facts.crews.length === 0 ? [{ kind: 'line', text: 'No crew assigned yet', tone: 'quiet' } as const] : [{ kind: 'line', text: `${site.people} ${site.people === 1 ? 'person' : 'people'} for ${facts.duration} days`, tone: 'quiet' } as const]),
      ];
    }
    if (lens === 'issues') {
      const rows: BoardRow[] = [{ kind: 'title', text: 'Issues' }];
      for (const issue of site.issues) rows.push({ kind: 'line', text: issue.text, tone: issue.tone });
      if (site.knockOnDays > 0) rows.push({ kind: 'line', text: `${site.knockOnDays} days late, because of the work before it`, tone: 'quiet' });
      if (site.issues.length === 0 && site.knockOnDays === 0) rows.push({ kind: 'line', text: 'Nothing here needs attention', tone: 'quiet' });
      return rows;
    }
    const use = rentalUse(site.days);
    const planned = standingOf(progress, facts.start.getTime(), facts.end.getTime(), now);
    const reported = facts.percent > 0 ? `Reported ${Math.round(facts.percent)}% done` : 'Nothing reported yet';
    const rows: BoardRow[] = [
      { kind: 'title', text: modelShows === 'reported' ? reported : planned },
      { kind: 'line', text: modelShows === 'reported' ? planned : reported, tone: 'quiet' },
    ];
    if (rentalLine(site)) rows.push({ kind: 'bar', label: `${facts.machine ?? 'Machine'}: booked days with work planned`, value: `${use.work} of ${use.booked}`, share: use.share, color: tokenColor('--warning-fill') });
    return rows;
  }

  /** Repaints a room's wall and rewrites its labels: when the day or the lens changes, not every frame. */
  function refreshRoom(piece: Piece): void {
    const stage = piece.stage;
    if (!stage) return;
    const key = `${lens}|${dayKey(now)}|${modelShows}`;
    if (stage.painted !== key) {
      stage.painted = key;
      stage.board.draw(roomBoardRows(piece));
    }
    for (const item of stage.labels) {
      const said = item.lenses.includes(lens) ? item.refresh() : null;
      item.element.hidden = !said;
      if (!said) continue;
      item.element.textContent = said.text;
      item.element.dataset.tone = said.tone ?? '';
      item.element.dataset.live = String(said.live ?? true);
    }
  }

  /** The rail closes in on a work's own days, unless someone asked for the whole plan. */
  function fitRail(): void {
    if (!rail) return;
    const facts = focus?.site.facts;
    const target = facts && !wholePlanOnRail ? [Math.max(span.start, facts.rulerStart.getTime() - WINDOW_MARGIN_DAYS * DAY_MS), Math.min(span.end, facts.rulerEnd.getTime() + WINDOW_MARGIN_DAYS * DAY_MS)] : [span.start, span.end];
    rail.markSpan(facts ? [facts.rulerStart.getTime(), facts.rulerEnd.getTime()] : null);
    const [fromA, toA] = railWindow;
    const [fromB, toB] = target as [number, number];
    stopRailMove?.();
    if (reducedMotion || fall) {
      railWindow = [fromB, toB];
      rail.setWindow(fromB, toB);
      return;
    }
    const controls = animate(0, 1, {
      duration: 0.9,
      ease: [0.2, 0, 0.1, 1],
      onUpdate: (t: number) => {
        railWindow = [fromA + (fromB - fromA) * t, toA + (toB - toA) * t];
        rail?.setWindow(railWindow[0], railWindow[1]);
      },
    });
    stopRailMove = () => controls.stop();
  }

  /** The date moves to the work: a short glide along the rail, so it is clear where it went. */
  function glideDateTo(piece: Piece): void {
    const { facts } = piece.site;
    const [from, to] = [facts.rulerStart.getTime(), facts.rulerEnd.getTime()];
    if (now >= from && now < to) return;
    stopGlide?.();
    const target = middayOf(from);
    if (reducedMotion) {
      setDate(target);
      return;
    }
    const controls = animate(now, target, { duration: 1.1, ease: [0.3, 0, 0.1, 1], onUpdate: (value: number) => setDate(value) });
    stopGlide = () => controls.stop();
  }

  function roomSize(plot: RoadPlot): [number, number] {
    return [Math.max(plot.w, 330), Math.max(plot.d, 260)];
  }

  /** Brings the camera to what this scene is about. It starts from wherever the camera is, so it never jumps. */
  function frameScene(seconds = 1.5, target?: Pose): void {
    if (!root) return;
    const to = target ?? (focus ? poseForWork(focus) : home);
    if (!to) return;
    if (handed) {
      pose = context.takeFromControls();
      handed = false;
    }
    if (!pose) return;
    shot = reducedMotion ? { from: to, to, t: 1, seconds: 1 } : { from: pose, to, t: 0, seconds };
    context.wake();
  }

  /** The one way scenes change. A move in progress just turns toward the new scene from where it is. */
  function goTo(next: SiteScene<TaskModel>): void {
    if (next.kind === 'chart') {
      close();
      return;
    }
    if (!root) {
      void open(next.kind === 'work' ? next.work : undefined);
      return;
    }
    if (closing || fall) return;
    pause();
    if (next.kind === 'board') fromChart = false;
    scene = next;
    if (next.kind === 'work') {
      const piece = pieces.find((item) => item.site.record === next.work) ?? null;
      if (focus && focus !== piece) seatOnBoard(focus);
      focus = piece;
      if (piece && !piece.room) piece.room = makeRoom(piece);
      if (piece) {
        context.selectTask(piece.site.record);
        seatInRoom(piece);
        glideDateTo(piece);
        refreshRoom(piece);
      }
    } else {
      // Back on the board, everyone goes back to their own spot on their plot.
      if (focus) seatOnBoard(focus);
      focus = null;
      stopGlide?.();
    }
    fitRail();
    applyShowing();
    for (const piece of pieces) if (piece !== focus) hideRoomLabels(piece);
    pinned = null;
    hovered = null;
    hoveredTile = null;
    pickedAt = null;
    offer.hidden = true;
    card.hidden = true;
    endSpotlight();
    shadowsMoving = 1;
    frameScene();
    syncBar();
    writeDiary();
  }

  function hideRoomLabels(piece: Piece): void {
    for (const item of piece.stage?.labels ?? []) item.element.hidden = true;
  }

  function up(): void {
    if (opening) return;
    if (closing) return;
    // In through the bar, back out through the bar.
    if (focus && fromChart) {
      close();
      return;
    }
    const next = upFrom(scene);
    if (next) goTo(next);
  }

  // ---------------------------------------------------------------------------------------
  // Building the board
  // ---------------------------------------------------------------------------------------

  /** The table's top: drawing paper and a tinted block per phase. The names are on the plates, which stay sharp. */
  function paintBoard(boardW: number, boardD: number, rows: readonly { y: number; height: number; color: string }[], lags: readonly { at: Point; text: string }[]): CanvasTexture {
    const scale = Math.min(2, 4096 / boardW);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(boardW * scale);
    canvas.height = Math.round(boardD * scale);
    const paint = canvas.getContext('2d')!;
    paint.scale(scale, scale);
    paint.fillStyle = '#f4f5f2';
    paint.fillRect(0, 0, boardW, boardD);
    const toX = (x: number) => x + boardW / 2;
    const toY = (y: number) => boardD / 2 - y;
    for (const item of rows) {
      const top = toY(item.y) - item.height / 2 - 52;
      paint.globalAlpha = 0.09;
      paint.fillStyle = item.color;
      paint.beginPath();
      paint.roundRect(28, top, boardW - 56, item.height + 114, 10);
      paint.fill();
      paint.globalAlpha = 1;
    }
    paint.fillStyle = '#20262e';
    paint.font = `540 14px "Archivo Variable", system-ui, sans-serif`;
    paint.textBaseline = 'bottom';
    for (const { at, text } of lags) paint.fillText(text, toX(at.x) + 8, toY(at.y) - 10);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 16;
    return texture;
  }

  /** The pale form of what a job will cost, and a solid layer for each cost line, stacked as the money goes out. */
  function stackBars(lines: readonly CostLine[], unit: number, across: number, deep: number, form: Color): MoneyBars {
    const group = new Group();
    const top = lines.reduce((sum, line) => sum + line.minor, 0) * unit;
    const shellMaterial = new MeshStandardMaterial({ color: form.clone().lerp(new Color('#ffffff'), 0.72), roughness: 0.55 });
    extraMaterials.push(shellMaterial);
    // Just lower than the money at its fullest, and narrower, so no two surfaces ever lie in the same place.
    const shell = solid(new BoxGeometry(across, deep, 1).translate(0, 0, 0.5), shellMaterial, 0, 0, 0);
    shell.scale.z = Math.max(0.5, top - MONEY_GAP);
    group.add(shell);
    const layer = new BoxGeometry(across + 1.2, deep + 1.2, 1).translate(0, 0, 0.5);
    const bars: MoneyBars = { group, segments: [], top, shell, shellShown: top, layer, unit };
    // What a machine costs standing idle goes out first, so it is at the bottom, where the money starts.
    for (const line of [...lines].sort((a, b) => Number(b.kind === 'idle') - Number(a.kind === 'idle'))) addLayer(bars, line);
    return bars;
  }

  function addLayer(bars: MoneyBars, line: CostLine): void {
    const material = new MeshStandardMaterial({ color: cssColor(paintOf(line.color)), roughness: 0.42 });
    extraMaterials.push(material);
    const fill = solid(bars.layer, material, 0, 0, 0);
    fill.visible = false;
    bars.group.add(fill);
    bars.segments.push({ fill, height: line.minor * bars.unit, shown: line.minor * bars.unit, line });
  }

  /** The column takes on new amounts: each layer eases to its new height, and one that is gone to nothing. */
  function resizeBars(bars: MoneyBars, lines: readonly CostLine[]): void {
    const same = (a: CostLine, b: CostLine): boolean => a.kind === b.kind && a.who === b.who;
    for (const segment of bars.segments) {
      const line = lines.find((item) => same(item, segment.line));
      segment.line = line ?? { ...segment.line, minor: 0 };
      segment.height = segment.line.minor * bars.unit;
    }
    for (const line of lines) if (!bars.segments.some((segment) => same(line, segment.line))) addLayer(bars, line);
    bars.top = lines.reduce((sum, line) => sum + line.minor, 0) * bars.unit;
  }

  function makeMoney(site: SiteTask, plot: RoadPlot, form: Color, colors: Record<string, MeshStandardMaterial>): MoneyBars | null {
    const money = site.money;
    if (!money || site.costs.length === 0) return null;
    const unit = 165 / peakMoney;
    const [across, deep] = [Math.min(plot.w - 60, 92), 70];
    const bars = stackBars(site.costs, unit, across, deep, form);
    bars.group.position.y = 8;
    // The budget: a thin hoop around the column, red if the forecast has gone past it.
    if (money.budget > 0) {
      const at = money.budget * unit;
      const [outerX, outerY, rail] = [across + 12, deep + 12, 2.6];
      for (const [x, y, wide, long] of [
        [0, outerY / 2 - rail / 2, outerX, rail],
        [0, -outerY / 2 + rail / 2, outerX, rail],
        [outerX / 2 - rail / 2, 0, rail, outerY],
        [-outerX / 2 + rail / 2, 0, rail, outerY],
      ] as const) {
        const side = solid(new BoxGeometry(wide, long, 2.6), money.expected > money.budget ? colors.over! : colors.line!, x, y, at);
        side.castShadow = false;
        bars.group.add(side);
      }
    }
    return bars;
  }

  /** The firm's logo and its number of people, painted on the ground. */
  function crewMarkMesh(crew: SiteTask['facts']['crews'][number], width: number, height: number, x: number, y: number): Mesh {
    const material = new MeshBasicMaterial({ map: paintCrewMark({ name: crew.name, color: crew.color, image: crew.image, icon: crew.icon, people: crew.people, usual: crew.usual }, width, height, { ink: tokenColor('--ink'), soft: tokenColor('--ink-soft'), paper: tokenColor('--surface') }), transparent: true, depthWrite: false, toneMapped: false });
    extraMaterials.push(material);
    const mesh = new Mesh(new PlaneGeometry(width, height), material);
    mesh.position.set(x, y, 0);
    mesh.renderOrder = 2;
    return mesh;
  }

  /** The plot shared out between its firms: each with its mark on the ground and a figure for each person. */
  function makeCrew(site: SiteTask, plot: RoadPlot): { group: Group; workers: Worker[]; marks: Group; spots: Piece['spots'] } {
    const group = new Group();
    const marks = new Group();
    const workers: Worker[] = [];
    const spots: Piece['spots'] = [];
    const crews = site.facts.crews;
    const kit = context.workers();
    const everyone = crews.reduce((sum, crew) => sum + crew.people, 0);
    const zones = crewZones(crews.map((crew) => crew.people), plot.w - 12);
    const markHeight = 40;
    const standFrom = -plot.d / 2 + 16 + markHeight;
    const standDepth = plot.d - markHeight - 34;
    crews.forEach((crew, crewIndex) => {
      const zone = zones[crewIndex]!;
      marks.add(crewMarkMesh(crew, Math.max(40, Math.min(zone.w - 8, 150)), markHeight, zone.x, -plot.d / 2 + 10 + markHeight / 2));
      const count = Math.max(1, Math.round((crew.people * Math.min(MOST_FIGURES, everyone)) / Math.max(1, everyone)));
      const area = { x: zone.x, y: standFrom + standDepth / 2, w: Math.max(30, zone.w - 16), d: standDepth };
      standingSpots(count, area).forEach((spot, index) => {
        if (kit) {
          const worker = kit.spawn(crew.color, WORKER_HEIGHT, workers.length + 1 + plot.x * 0.013 + plot.y * 0.017);
          worker.roam(area);
          worker.standAt(spot.x, spot.y, area);
          worker.setOnSite(false);
          group.add(worker.root);
          workers.push(worker);
          spots.push({ worker, crew: crewIndex, x: spot.x, y: spot.y, area });
        } else {
          const person = figure(m, crew.color, index * 0.9);
          person.position.set(spot.x, spot.y, 0);
          person.scale.setScalar(3);
          group.add(person);
        }
      });
    });
    marks.position.z = 0.6;
    marks.visible = false;
    group.add(marks);
    return { group, workers, marks, spots };
  }

  function makeBeacon(site: SiteTask, plot: RoadPlot): Piece['beacon'] {
    const issue = site.issues[0];
    if (!issue) return null;
    const color = cssColor(issue.tone === 'danger' ? tokenColor('--danger') : tokenColor('--warning-fill'));
    const group = new Group();
    const light = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, roughness: 0.3 });
    extraMaterials.push(light);
    group.add(solid(upright(2.2, 1, 8), m.machineDark));
    group.add(solid(new SphereGeometry(11, 18, 14), light, 0, 0, 1));
    group.position.set(plot.w / 2 - 22, plot.d / 2 - 22, PLINTH);
    return { group, light };
  }

  /** A barrier across the road: the plan cannot start this work before its date. It lifts when the date comes. */
  function makeGate(plot: RoadPlot, stripes: MeshStandardMaterial): Group {
    const gate = new Group();
    gate.position.set(-plot.dir * (plot.w / 2 + 24), 0, 0);
    gate.add(solid(upright(2.6, 30, 10), m.machineDark, 0, -28, 0), solid(upright(2.6, 14, 10), m.machineDark, 0, 28, 0));
    const arm = new Group();
    arm.name = 'arm';
    arm.position.set(0, -28, 28);
    arm.add(solid(new BoxGeometry(5, 58, 5), stripes, 0, 29, 0));
    gate.add(arm);
    return gate;
  }

  /** A flag at the end of the plot for a deadline, red if the work now runs past it. */
  function makeDeadline(plot: RoadPlot, missed: boolean, colors: Record<string, MeshStandardMaterial>): Group {
    const flag = new Group();
    flag.position.set(plot.dir * (plot.w / 2 - 12), plot.d / 2 - 12, PLINTH);
    flag.add(solid(upright(1.6, 62, 8), m.machineDark));
    flag.add(solid(new BoxGeometry(26, 1.2, 16), missed ? colors.over! : colors.spent!, 13, 0, 54));
    return flag;
  }

  /** PayPal's mark, in white, on a puck by the plot: blue when paid or on its way, ink when ready to pay. */
  function makePuck(site: SiteTask, plot: RoadPlot, colors: Record<string, MeshStandardMaterial>, loader: TextureLoader): Group | null {
    const { state } = site.payout;
    if (state === 'none') return null;
    const puck = new Group();
    const color = state === 'paid' || state === 'moving' ? colors.paid! : state === 'ready' ? colors.ready! : colors.over!;
    puck.add(solid(upright(25, 10, 36), color));
    const logoMaterial = new MeshBasicMaterial({ map: loader.load('/paypal/paypal-mark-white.svg'), transparent: true, toneMapped: false });
    extraMaterials.push(logoMaterial);
    const logo = new Mesh(new PlaneGeometry(26, 30), logoMaterial);
    logo.position.z = 10.2;
    puck.add(logo);
    puck.position.set(-plot.dir * (plot.w / 2 - 34), -plot.d / 2 + 34, PLINTH);
    return puck;
  }

  function fillCard(piece: Piece, x: number, y: number, withActions: boolean): void {
    const { facts } = piece.site;
    const head = document.createElement('b');
    head.textContent = `${facts.wbs ? `${facts.wbs} ` : ''}${facts.name}`;
    const items: HTMLElement[] = [head, ...factRows(piece), ...issuePills(piece)];
    if (withActions) {
      items.push(workActions(piece, true));
    } else {
      const hint = document.createElement('small');
      hint.className = 'fx3d-card-hint';
      hint.textContent = 'Click for actions, double-click to go in';
      items.push(hint);
    }
    card.replaceChildren(...items);
    card.classList.toggle('is-pinned', withActions);
    const { width, height } = context.size();
    card.hidden = false;
    // Kept on the screen by its real height: it changes with what the task has to say.
    card.style.setProperty('--x', `${Math.min(x + 18, width - card.offsetWidth - 12)}px`);
    card.style.setProperty('--y', `${Math.max(12, Math.min(y + 14, height - card.offsetHeight - 12))}px`);
  }

  // ---------------------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------------------

  /** What the scene shows, as the plan has it right now. */
  function readPlan() {
    const project = gantt.project as unknown as { taskStore: { allRecords: TaskModel[] }; resourceStore: { records: ResourceModel[] }; dependencyStore: { allRecords: DependencyModel[] }; timeRangeStore?: { records: { name?: string; startDate?: Date; endDate?: Date }[] } };
    const everyRecord = project.taskStore.allRecords.filter((record) => !(record as unknown as { isRoot?: boolean }).isRoot);
    const dated = everyRecord.filter((record) => record.startDate instanceof Date && record.endDate instanceof Date);
    const leaves = dated.filter((record) => record.isLeaf && !record.isMilestone);
    const milestones = dated.filter((record) => record.isMilestone);
    const sites = siteTasks(leaves, everyRecord, crewNames(project.resourceStore.records), look());
    const shape = [
      ...sites.map(({ record, facts }) => `${String(record.id)}<${String(record.parent?.id)}:${facts.duration}:${facts.machines.join()}:${facts.crews.map((crew) => `${crew.name}/${crew.people}`).join()}`),
      ...milestones.map((task) => String(task.id)),
      ...project.dependencyStore.allRecords.map((dep) => `${String((dep.fromEvent as unknown as TaskModel | null)?.id)}>${String((dep.toEvent as unknown as TaskModel | null)?.id)}`),
    ].join('|');
    return { project, everyRecord, dated, milestones, sites, shape };
  }

  /** Opens on the board or in a piece of work; given where the camera is, it opens there at once, with no way in. */
  async function open(work?: TaskModel, inPlace?: { camera: Pose | null }): Promise<void> {
    if (opening || root) return;
    opening = true;
    keptWork = null;
    // People are real models or nothing moves, so give them a moment to arrive; the simple figures are the last resort.
    await Promise.race([context.workersReady, new Promise((resolve) => setTimeout(resolve, 4000))]);
    const diving = Boolean(work) && !reducedMotion && !inPlace;
    if (work && diving) await revealBar(work);
    const { project, dated, milestones, sites, shape } = readPlan();
    builtShape = shape;
    const state = look();
    extraMaterials = [];

    // The chart's colors, read from its own classes, so a bar off screen matches one on screen.
    const probe = document.createElement('div');
    gantt.element.append(probe);
    const phaseColors = new Map<string, string>();
    const phaseOf = (task: TaskModel): string => {
      const name = phaseClass(task);
      let color = phaseColors.get(name);
      if (color === undefined) {
        probe.className = name;
        color = getComputedStyle(probe).getPropertyValue('--look-phase').trim() || tokenColor('--gray-600');
        phaseColors.set(name, color);
      }
      return color;
    };
    // A task's own color wins, then its crew's if the chart is coloring by crew: the same rule as its bar.
    const barColorOf = (task: TaskModel): string => {
      const lead = state.colorBy === 'crew' ? leadCrew(task) : undefined;
      return ownTaskColor(task) ?? (lead ? crewColor(lead) : phaseOf(task));
    };

    const wraps = new Map<TaskModel, { wrap: HTMLElement; bar: HTMLElement }>();
    for (const wrap of gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)) {
      const inner = wrap.querySelector<HTMLElement>('.b-gantt-task');
      const record = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (inner && record && inner.getBoundingClientRect().width > 0) wraps.set(original(record), { wrap, bar: inner });
    }

    span = {
      start: Math.min(...sites.map((site) => site.facts.rulerStart.getTime()), ...milestones.map((task) => (task.startDate as Date).getTime())),
      end: Math.max(...sites.map((site) => site.facts.rulerEnd.getTime()), ...milestones.map((task) => (task.startDate as Date).getTime() + DAY_MS)),
    };
    peakMoney = Math.max(1, ...sites.map((site) => Math.max(site.money?.expected ?? 0, site.money?.budget ?? 0)));
    // It opens where it was left, else on today or the nearest day the plan has: nothing plays until asked.
    now = middayOf(Math.min(span.end - DAY_MS / 2, Math.max(span.start, keptDate ?? planClock.now().getTime())));
    lastDay = -1;

    // Where everything stands: the order of the work, phase by phase.
    const siteByRecord = new Map(sites.map((site) => [site.record, site]));
    const predecessorsOf = (task: TaskModel): TaskModel[] => ((original(task).predecessors ?? []) as unknown as { fromEvent?: TaskModel | null }[]).map((dep) => dep.fromEvent).filter((item): item is TaskModel => Boolean(item)).map((item) => original(item));
    const items: RoadItem<TaskModel>[] = [
      ...sites.map((site) => ({
        key: site.record,
        group: site.record.parent,
        start: site.facts.start.getTime(),
        days: site.facts.duration,
        idleDays: Math.min(12, rentalUse(site.days).idle),
        before: predecessorsOf(site.record),
      })),
      ...milestones.map((task) => ({ key: original(task), group: task.parent, start: (task.startDate as Date).getTime(), days: 0, idleDays: 0, before: predecessorsOf(task) })),
    ];
    const road = layoutRoad(items);
    const boardW = road.width + MARGIN_X * 2;
    const boardD = road.depth + MARGIN_Y * 2;
    boardReach = Math.max(boardW, boardD);
    boardSize = { w: boardW, d: boardD };

    root = new Group();
    threeScene.add(root);

    // Every bar has somewhere to leave from: on screen where it is drawn, off screen where it would be.
    const anchorRecord = wraps.keys().next().value as TaskModel | undefined;
    const axis = (gantt as unknown as { timeAxisViewModel?: { getDistanceBetweenDates(a: Date, b: Date): number } }).timeAxisViewModel;
    const rowsStore = gantt as unknown as { store: { indexOf(record: TaskModel): number }; rowHeight: number };
    const scheduleView = gantt as unknown as { subGrids: { normal: { element: HTMLElement } }; bodyContainer: HTMLElement };
    const rectOnPage = (record: TaskModel): { left: number; top: number; width: number; height: number } => {
      const found = wraps.get(record);
      if (found?.bar.isConnected) {
        const rect = found.bar.getBoundingClientRect();
        if (rect.width > 0) return rect;
      }
      const start = record.startDate as Date;
      const end = record.endDate as Date;
      const anchor = anchorRecord ? wraps.get(anchorRecord)?.bar.getBoundingClientRect() : null;
      if (!anchorRecord || !anchor) return { left: context.size().width / 2 - 30, top: context.size().height * 1.5, width: 60, height: 26 };
      const anchorStart = anchorRecord.startDate as Date;
      const sample = axis?.getDistanceBetweenDates(anchorStart, anchorRecord.endDate as Date) ?? 0;
      const span2 = (anchorRecord.endDate as Date).getTime() - anchorStart.getTime();
      const perMs = sample > 0 && span2 > 0 ? sample / span2 : 34 / DAY_MS;
      const rows = rowsStore.store.indexOf(record) - rowsStore.store.indexOf(anchorRecord);
      return { left: anchor.left + (start.getTime() - anchorStart.getTime()) * perMs, top: anchor.top + rows * rowsStore.rowHeight, width: Math.max(10, (end.getTime() - start.getTime()) * perMs), height: anchor.height };
    };
    const barRectOf = (record: TaskModel): Piece['from'] => {
      const { width, height } = context.size();
      const rect = rectOnPage(record);
      const across = scheduleView.subGrids.normal.element.getBoundingClientRect();
      const down = scheduleView.bodyContainer.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const midY = rect.top + rect.height / 2;
      const nearX = Math.min(across.right, Math.max(across.left, midX));
      const nearY = Math.min(down.bottom, Math.max(down.top, midY));
      return { x: nearX - width / 2, y: height / 2 - nearY, w: rect.width, d: rect.height, outOfSight: nearX !== midX || nearY !== midY };
    };
    barRectFor = barRectOf;

    // The table itself.
    const printed = new MeshStandardMaterial({ roughness: 0.86, transparent: true, opacity: 0 });
    const edge = new MeshPhysicalMaterial({ color: cssColor(tokenColor('--gray-700')), roughness: 0.5, transparent: true, opacity: 0 });
    boardMaterials = [printed, edge];
    const slab = solid(new RoundedBoxGeometry(boardW, boardD, 22, 3, 3), edge, 0, 0, -11.5);
    slab.castShadow = false;
    const paper = new Mesh(new PlaneGeometry(boardW - 2, boardD - 2), printed);
    paper.receiveShadow = true;
    paper.position.z = 0.1;
    // Before the graph paper: both can be see-through, and drawn after it they would paint over it.
    slab.renderOrder = -3;
    paper.renderOrder = -3;
    root.add(slab, paper);
    graphPaper = createGraphPaper(boardReach * 12);
    root.add(graphPaper.group);

    // The board is a room too: two walls at its back, so the whole site reads as one cutaway model.
    boardWalls = new Group();
    const boardWallMaterial = new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-100')), roughness: 0.9 });
    const boardSkirtMaterial = new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-700')), roughness: 0.6 });
    extraMaterials.push(boardWallMaterial, boardSkirtMaterial);
    boardBackWall = new Group();
    boardSideWall = new Group();
    boardBackWall.add(
      solid(new BoxGeometry(boardW + 10, 10, BOARD_WALL).translate(0, 0, BOARD_WALL / 2), boardWallMaterial, 5, boardD / 2 + 5, 0),
      solid(new BoxGeometry(boardW, 2, 12).translate(0, 0, 6), boardSkirtMaterial, 0, boardD / 2 - 1, 0),
    );
    boardSideWall.add(
      solid(new BoxGeometry(10, boardD, BOARD_WALL).translate(0, 0, BOARD_WALL / 2), boardWallMaterial, boardW / 2 + 5, 0, 0),
      solid(new BoxGeometry(2, boardD, 12).translate(0, 0, 6), boardSkirtMaterial, boardW / 2 - 1, 0, 0),
    );
    boardWalls.add(boardBackWall, boardSideWall);
    boardWalls.scale.z = 0.001;
    boardWalls.visible = false;
    root.add(boardWalls);

    const colors = {
      paid: new MeshStandardMaterial({ color: cssColor(tokenColor('--paypal-blue')), roughness: 0.4 }),
      spent: new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-800')), roughness: 0.5 }),
      over: new MeshStandardMaterial({ color: cssColor(tokenColor('--danger')), roughness: 0.4 }),
      idle: new MeshStandardMaterial({ color: cssColor(tokenColor('--warning-fill')), roughness: 0.4 }),
      slack: new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-200')), roughness: 0.7 }),
      line: new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-800')), metalness: 0.3, roughness: 0.4 }),
      // Ready to pay is something to do: ink, as the button that reviews it.
      ready: new MeshStandardMaterial({ color: cssColor(tokenColor('--ink')), roughness: 0.35 }),
      stripes: new MeshStandardMaterial({ map: stripesTexture(), roughness: 0.5 }),
      band: new MeshStandardMaterial({ color: '#000000', transparent: true, opacity: 0.22, roughness: 0.6 }),
    };
    boardColors = colors;
    const checkMaterial = new MeshBasicMaterial({ map: checkTexture(), transparent: true, toneMapped: false });
    nothing = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    extraMaterials.push(...Object.values(colors), checkMaterial, nothing);
    const textures = new TextureLoader();
    const withModels = sites.length <= MODEL_LIMIT;
    const white = new Color('#ffffff');
    const canvasColor = cssColor(tokenColor('--canvas'));

    pieces = sites.map((site) => {
      const plot = road.plots.get(site.record)!;
      // Opening in place nothing flies in, so no bar needs its picture taken.
      const found = inPlace ? undefined : wraps.get(site.record);
      const from = barRectOf(site.record);
      const barColor = cssColor(barColorOf(site.record));
      // The bar's own three looks: a pale ghost before it starts, solid while under way, quiet when done.
      const ghostColor = barColor.clone().lerp(white, 0.84);
      const doneColor = barColor.clone().lerp(canvasColor, 0.72);
      const shell = new MeshPhysicalMaterial({ color: ghostColor.clone(), roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3 });
      const rimMaterial = new MeshPhysicalMaterial({ color: barColor, roughness: 0.4 });
      extraMaterials.push(shell, rimMaterial);
      const group = new Group();
      const body = new Group();
      // A rim in the bar's color, as a not-started bar has its outline.
      const rim = solid(new RoundedBoxGeometry(plot.w + 3, plot.d + 3, 6, 3, 2), rimMaterial, 0, 0, 3);
      rim.castShadow = false;
      const plinth = solid(new RoundedBoxGeometry(plot.w, plot.d, PLINTH, 3, 2.4), shell, 0, 0, PLINTH / 2);
      body.add(rim, plinth);
      const dressing = new Group();
      group.add(body, dressing);
      root!.add(group);

      // How far along it is: the bar's percent band, across the plot from where the road comes in.
      const band = solid(new BoxGeometry(plot.w - 2, plot.d - 2, 0.4), colors.band, 0, 0, PLINTH + 0.3);
      band.castShadow = false;
      band.visible = false;
      dressing.add(band);
      const edgeMarks: Mesh[] = [];
      let keelMaterial: MeshStandardMaterial | null = null;
      if (site.critical) {
        // The chart marks critical work with a heavy keel along the bar's bottom edge.
        keelMaterial = new MeshStandardMaterial({ color: barColor.clone().lerp(keelDark, 0.45), roughness: 0.5 });
        extraMaterials.push(keelMaterial);
        const keel = solid(new BoxGeometry(plot.w, 6, PLINTH + 1), keelMaterial, 0, -plot.d / 2 + 3, (PLINTH + 1) / 2);
        keel.castShadow = false;
        dressing.add(keel);
        edgeMarks.push(keel);
      }
      const check = new Mesh(new PlaneGeometry(26, 26), checkMaterial);
      check.position.set(plot.dir * (plot.w / 2 - 22), -plot.d / 2 + 22, PLINTH + 0.6);
      check.visible = false;
      dressing.add(check);

      // The bar's own face, while it flies to its plot and fades out as it lands.
      let face: Mesh | null = null;
      let faceMaterial: MeshBasicMaterial | null = null;
      if (found) {
        faceMaterial = new MeshBasicMaterial({ map: context.makeBlockFace(found.wrap, found.bar), transparent: true, toneMapped: false });
        face = new Mesh(new PlaneGeometry(1, 1), faceMaterial);
        group.add(face);
      }

      // Machine booked with no work planned: an amber strip behind the plot, as long as the idle days.
      let idleStrip: Mesh | null = null;
      if (plot.idleW > 0) {
        idleStrip = solid(new BoxGeometry(plot.idleW, 26, 6), colors.idle, -plot.dir * (plot.w / 2 + plot.idleW / 2), -plot.d / 2 + 13, 3);
        idleStrip.castShadow = false;
        const use = rentalUse(site.days);
        const words = `${use.idle} ${use.idle === 1 ? 'day' : 'days'} idle${site.idleCostMinor > 0 ? ` · ${spentWords(compactMoney(site.idleCostMinor, state.currency))}` : ''}`;
        const stripTop = new MeshBasicMaterial({ map: paintIdleStrip(use.idle, words, plot.idleW, 26, { idle: tokenColor('--warning-fill'), ink: tokenColor('--ink') }), toneMapped: false });
        extraMaterials.push(stripTop);
        const printed2 = new Mesh(new PlaneGeometry(plot.idleW, 26), stripTop);
        printed2.position.z = 3.05;
        idleStrip.add(printed2);
        dressing.add(idleStrip);
      }

      // How far it can slip: a pale strip after the plot, on the side the road leaves by, a tick a day.
      let slackStrip: Mesh | null = null;
      if (site.slackDays > 0) {
        const dayLength = ROAD.dayWidth;
        const length = Math.min(ROAD.stationGap - 8, Math.max(26, site.slackDays * dayLength));
        slackStrip = solid(new BoxGeometry(1, 26, 2), colors.slack, plot.dir * (plot.w / 2 + length / 2), -plot.d / 2 + 13, 1.6);
        slackStrip.castShadow = false;
        slackStrip.userData.length = length;
        slackStrip.visible = false;
        const slackMaterial = new MeshBasicMaterial({ map: paintSlack(site.slackDays, length, 26), toneMapped: false });
        extraMaterials.push(slackMaterial);
        const face2 = new Mesh(new PlaneGeometry(1, 26), slackMaterial);
        face2.position.z = 1.1;
        slackStrip.add(face2);
        dressing.add(slackStrip);
      }

      // One tick a day along the front edge, so the edge and the strip read as one small bar on a ruler.
      const workDayCount = site.facts.workDays.length;
      if (workDayCount > 1 && workDayCount <= 40) {
        const ticks: BoxGeometry[] = [];
        for (let day = 1; day < workDayCount; day++) ticks.push(new BoxGeometry(1.2, 5.6, 0.5).translate(-plot.w / 2 + (day * plot.w) / workDayCount, -plot.d / 2 + 3, (site.critical ? PLINTH + 1 : PLINTH) + 0.3));
        const merged = mergeGeometries(ticks);
        for (const tick of ticks) tick.dispose();
        const ruler = new Mesh(merged, colors.line);
        dressing.add(ruler);
        edgeMarks.push(ruler);
      }

      const work = new Group();
      work.position.z = PLINTH;
      const ghostMaterial = new MeshStandardMaterial({ color: barColor.clone().lerp(white, 0.72), roughness: 0.82, transparent: true });
      const paleMaterial = new MeshStandardMaterial({ color: barColor.clone().lerp(white, 0.72), roughness: 0.82 });
      extraMaterials.push(ghostMaterial, paleMaterial);
      const { kit, ghosts, ghostKit } = withModels || site.facts.machines.length > 0 ? addModel(site, work, ghostMaterial) : { kit: null, ghosts: [], ghostKit: null };
      dressing.add(work);
      skipWhileHidden(work);

      const money = makeMoney(site, plot, barColor, colors);
      if (money) {
        money.group.position.z = PLINTH;
        dressing.add(money.group);
      }
      if (money) skipWhileHidden(money.group);
      const crew = makeCrew(site, plot);
      crew.group.position.z = PLINTH;
      skipWhileHidden(crew.group);
      dressing.add(crew.group);
      const beacon = makeBeacon(site, plot);
      if (beacon) dressing.add(beacon.group);
      const { constraint, deadline } = site.facts;
      const gate = constraint?.holdsStart ? makeGate(plot, colors.stripes) : null;
      if (gate) dressing.add(gate);
      if (deadline) dressing.add(makeDeadline(plot, site.facts.end > deadline, colors));
      if (constraint && !constraint.holdsStart) {
        dressing.add(solid(new OctahedronGeometry(9), colors.spent, plot.dir * (plot.w / 2 - 12), -plot.d / 2 + 12, PLINTH + 12));
      }
      const puck = makePuck(site, plot, colors, textures);
      if (puck) dressing.add(puck);

      // Low, so a tall model in front does not take the pointer from the plot behind it.
      const hit = new Mesh(new BoxGeometry(plot.w, plot.d, 50));
      hit.position.z = 25;
      hit.visible = false;
      group.add(hit);

      const piece: Piece = {
        site,
        plot,
        from,
        idleStrip,
        edgeMarks,
        rim: rimMaterial,
        crewLook: site.facts.crews[0] ? { bar: cssColor(site.facts.crews[0].color), ghost: cssColor(site.facts.crews[0].color).lerp(white, 0.84), done: cssColor(site.facts.crews[0].color).lerp(canvasColor, 0.72) } : null,
        keel: keelMaterial,
        slackStrip,
        slackU: 0,
        delay: within(site.facts.start.getTime(), span.start, span.end),
        group,
        body,
        dressing,
        plinth,
        shell,
        barColor,
        ghostColor,
        doneColor,
        band,
        check,
        face,
        faceMaterial,
        kit,
        roomOnlyModel: false,
        ghosts,
        ghostKit,
        ghostMaterial,
        paleMaterial,
        realMode: 'full',
        room: null,
        stage: null,
        plate: createPlate(plateLayer, 'plot', undefined, () => {
          if (lens !== 'issues') return;
          const { issues } = pieces.find((item) => item.plot === plot)?.site ?? site;
          const issue = issues.find((item) => now < item.from) ?? issues[0];
          if (!issue) return;
          pause();
          setDate(middayOf(issue.from));
        }),
        roomU: 0,
        shown: 0,
        work,
        money,
        crew: crew.group,
        crewMarks: crew.marks,
        workers: crew.workers,
        spots: crew.spots,
        beacon,
        gate,
        puck,
        hit,
        u: { work: 0, money: 0, crew: 0, beacon: 0, hover: 0 },
        progress: progressAt(site.facts, now),
        railColor: barColorOf(site.record),
        savedMinor: 0,
        idleU: 1,
      };
      group.position.set(from.x, from.y, 0);
      return piece;
    });

    // Milestones: a gem on a post at the end of their stretch of road.
    gems = milestones.map((task) => {
      const record = original(task);
      const plot = road.plots.get(record)!;
      const group = new Group();
      group.position.set(plot.x, plot.y, 0);
      group.add(solid(new RoundedBoxGeometry(plot.w, plot.d, 9, 3, 2.4), m.machineDark, 0, 0, 4.5));
      const post = solid(upright(2.4, 1, 10), m.machineDark, 0, 0, 9);
      const gemMaterial = new MeshPhysicalMaterial({ color: cssColor(tokenColor('--warning-fill')), metalness: 0.2, roughness: 0.16, clearcoat: 1 });
      extraMaterials.push(gemMaterial);
      const stone = solid(new OctahedronGeometry(26), gemMaterial, 0, 0, 0);
      group.add(post, stone);
      root!.add(group);
      return { group, at: (task.startDate as Date).getTime(), stone, post, record };
    });

    // Each phase's own summary bar along the back of its block, filling as its work is built.
    phaseBars = road.rows.map((roadRow) => {
      const tasks = pieces.filter((piece) => piece.site.record.parent === roadRow.group);
      const color = cssColor(tasks[0] ? phaseOf(tasks[0].site.record) : tokenColor('--gray-600'));
      const left = -road.width / 2 + 190;
      const widthOf = road.width - 190;
      const y = roadRow.y + roadRow.height / 2 + 30;
      const trackMaterial = new MeshStandardMaterial({ color: color.clone().lerp(white, 0.75), roughness: 0.6 });
      const fillMaterial = new MeshStandardMaterial({ color, roughness: 0.45 });
      extraMaterials.push(trackMaterial, fillMaterial);
      const track = solid(new BoxGeometry(widthOf, 7, 2), trackMaterial, left + widthOf / 2, y, 1.1);
      track.castShadow = false;
      const fill = solid(new BoxGeometry(1, 7.4, 3).translate(0.5, 0, 0), fillMaterial, left, y, 1.6);
      fill.castShadow = false;
      track.visible = false;
      fill.visible = false;
      root!.add(track, fill);
      return { track, fill, tasks, width: widthOf };
    });

    // Names, with their WBS number; the lag on a link where the plan has one.
    const wbsOf = (task: TaskModel): string => {
      const code = (original(task) as unknown as { wbsCode?: unknown }).wbsCode;
      return code == null ? '' : `${String(code)} `;
    };
    const shortDay = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const lags: { at: Point; text: string }[] = [];
    // The turnarounds at the row ends stay clear of the phase names in the margin.
    const turnaroundOut = road.width / 2 + 82;

    // The road: right angles, on the table, one ribbon from each step of work to the next.
    const laneMaterial = (map: CanvasTexture) => new MeshStandardMaterial({ map, roughness: 0.7, transparent: true, opacity: 0, depthWrite: false, side: DoubleSide });
    laneMaterials = {
      ahead: laneMaterial(chevronTexture(tokenColor('--gray-300'), tokenColor('--gray-400'))),
      done: laneMaterial(chevronTexture(tokenColor('--accent'), tokenColor('--accent-line'))),
      lit: laneMaterial(chevronTexture(tokenColor('--ink'), tokenColor('--gray-300'))),
    };
    lanes = [];
    for (const dep of project.dependencyStore.allRecords) {
      const fromTask = dep.fromEvent as unknown as TaskModel | null;
      const toTask = dep.toEvent as unknown as TaskModel | null;
      if (!fromTask || !toTask) continue;
      const a = road.plots.get(original(fromTask));
      const b = road.plots.get(original(toTask));
      if (!a || !b) continue;
      const route = roadRoute(a, b, turnaroundOut);
      const mesh = new Mesh(ribbon(roundedRoute(route, 22, 8), 15, 1.6, 30), laneMaterials.ahead);
      mesh.receiveShadow = true;
      // Paint on the table: after it, and leaving no mark in the depth buffer, or it would cut holes as it fades.
      mesh.renderOrder = 1;
      root.add(mesh);
      lanes.push({ mesh, doneAt: (fromTask.endDate as Date).getTime(), from: original(fromTask), to: original(toTask) });
      const lag = (dep as unknown as { lag?: number }).lag ?? 0;
      if (lag !== 0) lags.push({ at: { x: b.x - b.dir * (b.w / 2 + 40), y: b.y }, text: `${lag > 0 ? '+' : ''}${lag} ${Math.abs(lag) === 1 ? 'day' : 'days'}` });
    }

    const phaseColor = (group: unknown): string => {
      const site = sites.find((item) => item.record.parent === group);
      return site ? phaseOf(site.record) : tokenColor('--gray-600');
    };
    const groupName = (group: unknown): string => {
      const node = group as { name?: string; wbsCode?: unknown } | null;
      return `${node?.wbsCode == null ? '' : `${String(node.wbsCode)} `}${node?.name ?? ''}`;
    };
    printed.map = paintBoard(
      boardW,
      boardD,
      road.rows.map((roadRow) => ({ y: roadRow.y, height: roadRow.height, color: phaseColor(roadRow.group) })),
      lags,
    );
    printed.needsUpdate = true;

    // A label for each phase, at the head of its block, and for each milestone.
    phasePlates = road.rows.map((roadRow) => {
      const tasks = pieces.filter((piece) => piece.site.record.parent === roadRow.group);
      return {
        plate: createPlate(plateLayer, 'phase', phaseColor(roadRow.group)),
        at: new Vector3(-boardW / 2 + 34, roadRow.y + roadRow.height / 2 + 34, 0),
        tasks,
        name: groupName(roadRow.group),
        start: Math.min(...tasks.map((piece) => piece.site.facts.start.getTime())),
        end: Math.max(...tasks.map((piece) => piece.site.facts.end.getTime())),
      };
    });
    milestonePlates = gems.map((gem) => {
      const plot = road.plots.get(gem.record)!;
      return { plate: createPlate(plateLayer, 'plot'), at: new Vector3(plot.x - plot.w / 2, plot.y - plot.d / 2, 0), record: gem.record, name: `${wbsOf(gem.record)}${gem.record.name ?? ''}`, date: shortDay(gem.record.startDate as Date), late: slipDays(gem.record) };
    });

    // The date, large, on the board's back wall: where in the plan this board is showing.
    const [dateW, dateH] = [Math.min(860, boardW * 0.5), 176];
    dateBoard = createWallBoard(dateW, dateH, { ink: tokenColor('--ink'), soft: tokenColor('--ink-soft'), track: tokenColor('--gray-200'), danger: tokenColor('--danger'), caution: tokenColor('--warning-fill') }, 1536);
    dateBoard.mesh.rotation.x = Math.PI / 2;
    dateBoard.mesh.position.set(-boardW / 2 + dateW / 2 + 60, boardD / 2 - 0.6, BOARD_WALL - dateH / 2 - 16);
    boardBackWall?.add(dateBoard.mesh);

    // The date rail: rows in the plan's order, bars in the chart's colors.
    const rowOf = new Map<TaskModel, number>();
    const railPhases: { label: string; firstRow: number; rows: number }[] = [];
    let lastGroup: unknown = null;
    for (const record of dated.filter((task) => task.isLeaf)) {
      const task = original(record);
      const top = topLevelOf(task);
      rowOf.set(task, rowOf.size);
      if (top !== lastGroup) {
        railPhases.push({ label: groupName(top), firstRow: rowOf.size - 1, rows: 1 });
        lastGroup = top;
      } else {
        railPhases[railPhases.length - 1]!.rows += 1;
      }
    }
    const railBarsNow = (): RailBar[] => pieces.map((piece) => {
      const { site } = piece;
      const { facts } = site;
      const baseline = (site.record as unknown as { baselines?: { first?: { startDate?: Date; endDate?: Date } } }).baselines?.first;
      const moved = baseline?.startDate instanceof Date && baseline.endDate instanceof Date && (baseline.startDate.getTime() !== facts.start.getTime() || baseline.endDate.getTime() !== facts.end.getTime());
      return {
        key: site.record,
        label: `${facts.wbs ? `${facts.wbs} ` : ''}${facts.name} · ${shortDate(facts.start)} to ${shortDate(new Date(facts.end.getTime() - 1))}`,
        row: rowOf.get(site.record) ?? 0,
        start: facts.start.getTime(),
        end: facts.end.getTime(),
        color: piece.railColor,
        critical: site.critical,
        idle: idleStretches(site.days, facts.start.getTime()).map((stretch) => [stretch.side === 'before' ? stretch.from : facts.end.getTime(), stretch.side === 'before' ? facts.start.getTime() : stretch.to] as const),
        clashes: site.issues.filter((issue) => issue.kind === 'booked').map((issue) => [issue.from, issue.to] as const),
        baseline: moved && baseline.startDate && baseline.endDate ? [baseline.startDate.getTime(), baseline.endDate.getTime()] : null,
        constraint: facts.constraint ? { at: facts.constraint.date.getTime(), label: facts.constraint.label } : null,
        deadline: facts.deadline ? { at: facts.deadline.getTime(), missed: facts.end > facts.deadline } : null,
        payout: site.payout.state,
      };
    });
    const railColors = {
      ink: tokenColor('--ink'),
      soft: tokenColor('--ink-faint'),
      line: tokenColor('--line'),
      accent: tokenColor('--accent'),
      warning: tokenColor('--warning-fill'),
      danger: tokenColor('--danger'),
      paypal: tokenColor('--paypal-blue'),
      ready: tokenColor('--ink'),
      weekend: tokenColor('--gray-100'),
    };
    railBuild = () => {
      rail?.destroy();
      rail = createDateRail({
        start: span.start,
        end: span.end,
        bars: railBarsNow(),
        milestones: milestones.map((task) => ({ label: task.name ?? '', row: rowOf.get(original(task)) ?? 0, at: (task.startDate as Date).getTime() })),
        phases: railPhases,
        bands: (project.timeRangeStore?.records ?? []).flatMap((range) => (range.startDate instanceof Date && range.endDate instanceof Date && range.endDate > range.startDate ? [{ label: range.name ?? '', from: range.startDate.getTime(), to: range.endDate.getTime() }] : [])),
        rowCount: rowOf.size,
        colors: railColors,
        onDate: (at) => {
          pause();
          setDate(at);
        },
        onHover: (key) => {
          railHover = key;
          context.wake();
        },
      });
      railSlot.replaceChildren(rail.element);
    };
    railBuild();
    railWindow = [span.start, span.end];
    wholePlanOnRail = false;
    railKey.replaceChildren(
      swatch(railColors.warning, 'Machine idle'),
      swatch(railColors.danger, 'Booked twice'),
      swatch(railColors.ink, 'Constraint', 'is-triangle'),
      swatch(railColors.ink, 'Deadline', 'is-line'),
      swatch(railColors.ink, 'Milestone', 'is-diamond'),
      swatch(railColors.paypal, 'PayPal', 'is-dot'),
      directions,
    );
    probe.remove();

    // The walk: the work in the order the road takes it.
    navPlan = {
      order: road.rows.flatMap((roadRow) => roadRow.keys).filter((key) => siteByRecord.has(key)),
      name: (task) => {
        const site = siteByRecord.get(task);
        return `${site?.facts.wbs ? `${site.facts.wbs} ` : ''}${task.name ?? ''}`;
      },
    };

    // The work front's road: one stop for each step along it. Work side by side is one stop, as long as the longest of it.
    const frontStops = (): FrontStop[] => {
    const stations: { plot: RoadPlot; start: number; end: number }[] = [];
    for (const key of navPlan.order) {
      const plot = road.plots.get(key)!;
      const site = pieces.find((piece) => piece.site.record === key)!.site;
      const [start, end] = [site.facts.start.getTime(), site.facts.end.getTime()];
      const last = stations[stations.length - 1];
      if (last && last.plot.row === plot.row && last.plot.rank === plot.rank) {
        last.start = Math.min(last.start, start);
        if (end > last.end) last.plot = plot;
        last.end = Math.max(last.end, end);
      } else {
        stations.push({ plot, start, end });
      }
    }
    return stations.map(({ plot, start, end }, index) => {
      const before = stations[index - 1]?.plot;
      const backY = plot.y + plot.d / 2 + 20;
      const [inX, outX] = [plot.x - (plot.dir * plot.w) / 2, plot.x + (plot.dir * plot.w) / 2];
      return {
        road: before ? roundedRoute(roadRoute(before, plot, turnaroundOut), 22, 6) : [],
        along: [{ x: inX, y: plot.y }, { x: inX, y: backY }, { x: outX, y: backY }, { x: outX, y: plot.y }],
        start,
        end,
      };
    });
    };
    readFrontStops = frontStops;
    const marker = createFrontMarker(context.pin);
    root.add(marker.root);
    const truckTag = document.createElement('span');
    truckTag.className = 'fx3d-tag fx3d-front-tag';
    tags.append(truckTag);
    front = { route: frontRoute(frontStops()), marker, tag: truckTag, u: 0 };

    // The flowline's lines: firms' colors on phases' rows.
    flowlineRows = railPhases.map((phase) => phase.label);
    flowWorksNow = () => pieces.map((piece): FlowWork => {
      const { site } = piece;
      const { facts } = site;
      let row = 0;
      railPhases.forEach((phase, index) => {
        const at = rowOf.get(site.record) ?? 0;
        if (at >= phase.firstRow && at < phase.firstRow + phase.rows) row = index;
      });
      return {
        key: site.record,
        label: facts.name,
        code: facts.wbs,
        dates: `${shortDate(facts.start)} to ${shortDate(new Date(facts.end.getTime() - 1))}`,
        row,
        start: facts.start.getTime(),
        end: facts.end.getTime(),
        crew: facts.crews[0]?.name ?? '',
        color: facts.crews[0]?.color ?? cssColorText(piece.barColor),
        idleFrom: facts.rulerStart < facts.start ? facts.rulerStart.getTime() : null,
        idleUntil: facts.rulerEnd > facts.end ? facts.rulerEnd.getTime() : null,
        clashes: site.issues.filter((issue) => issue.kind === 'booked').map((issue) => [issue.from, issue.to] as const),
        critical: site.critical,
      };
    });
    flowlineWorks = flowWorksNow();

    // The bars have left the chart: their copies are in the air, so the real ones step aside until they land.
    // Falling into a bar, nothing has left: the chart stays whole until the camera is through it.
    slotted = diving || inPlace ? [] : [...wraps.values()].map((item) => item.wrap);
    for (const wrap of slotted) wrap.classList.add('fx3d-slot');

    lens = keptLens;
    document.body.append(nav, bar, diary, plateLayer, tags, roomLayer, light, card, offer, caption);
    card.hidden = true;
    pinned = null;
    focus = null;
    const openedPiece = work ? pieces.find((piece) => piece.site.record === original(work)) : undefined;
    // Already, so that nothing is written for the board that the room is about to cover.
    scene = openedPiece ? { kind: 'work', work: openedPiece.site.record } : { kind: 'board' };
    // Opened from a bar: the date starts on that work's own days.
    if (openedPiece && !inPlace) now = middayOf(openedPiece.site.facts.rulerStart.getTime());
    if (openedPiece && !inPlace) context.selectTask(openedPiece.site.record);
    fromChart = Boolean(openedPiece);
    context.setLive(true);
    setDate(now);
    syncBar();
    document.documentElement.style.setProperty('--fx3d-bar-height', `${bar.offsetHeight}px`);

    // The camera: a three-quarter view with the whole table in the space the controls leave free.
    home = fitPose();
    const opened = openedPiece;
    pose = home;
    if (opened) {
      scene = { kind: 'work', work: opened.site.record };
      focus = opened;
      opened.room = makeRoom(opened);
      seatInRoom(opened);
      pose = poseForWork(opened);
      refreshRoom(opened);
      fitRail();
      syncBar();
      writeDiary();
    }
    context.fitShadow(0, 0, boardReach * 0.62);
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    opening = false;

    applyShowing();

    if (reducedMotion || inPlace) {
      s = 1;
      context.sheetOpacity(0);
      showPanels();
      if (inPlace) {
        pose = inPlace.camera ?? pose;
        focusU = opened ? 1 : 0;
        if (opened) opened.roomU = 1;
      }
    } else if (diving && opened) {
      s = 1;
      focusU = 1;
      const room = poseForWork(opened);
      startFall(0, opened, room, opened.site.record);
      // All the waiting happens here, standing still on the chart: compile what will be seen, so nothing stalls mid-fall.
      if (printed.map) renderer.initTexture(printed.map);
      renderer.compile(threeScene, camera);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      runFall(1);
    } else {
      const controls = animate(0, 1, {
        duration: OPEN_SECONDS,
        ease: 'linear',
        onUpdate: (value: number) => {
          s = value;
          if (value > 0.72) showPanels();
          context.wake();
        },
      });
      stopTransition = () => controls.stop();
    }
    context.wake();
  }

  function showPanels(): void {
    document.documentElement.classList.add('fx3d-panels');
    bar.classList.add('is-shown');
    diary.classList.add('is-shown');
    nav.classList.add('is-shown');
  }

  /** Puts the Show menu's choices on the board. The truck and strips ease themselves in each frame. */
  function applyShowing(): void {
    syncBar();
    refreshPlates();
    shadowsMoving = 1;
    if (showing.flow && !focus && !flowline && rail) {
      const { railColors } = flowlineColors();
      flowline = createFlowline({
        rows: flowlineRows,
        works: flowlineWorks,
        start: span.start,
        end: span.end,
        colors: railColors,
        onOpen: (key) => goTo({ kind: 'work', work: key as TaskModel }),
        onHover: (key) => {
          railHover = key;
          context.wake();
        },
      });
      document.body.append(flowline.element);
      flowline.show(now);
    } else if ((!showing.flow || focus) && flowline) {
      flowline.destroy();
      flowline = null;
    }
    context.wake();
  }

  const flowlineColors = () => ({
    railColors: { ink: tokenColor('--ink'), soft: tokenColor('--ink-faint'), line: tokenColor('--line'), idle: tokenColor('--warning-fill'), danger: tokenColor('--danger'), weekend: tokenColor('--gray-100') },
  });

  /** Scrolls the chart so this bar is on the screen: falling into a bar needs it there to fall into. */
  async function revealBar(task: TaskModel): Promise<void> {
    try {
      await (gantt as unknown as { scrollTaskIntoView(task: TaskModel, options: object): Promise<void> }).scrollTaskIntoView(task, { block: 'nearest', edgeOffset: 80, animate: false });
    } catch {
      // Filtered out or collapsed: it goes from where it would be.
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /** Where a bar is drawn right now, in the world the camera sees. */
  function barOnChart(task: TaskModel): { x: number; y: number; w: number; d: number } {
    const { width, height } = context.size();
    const wanted = original(task);
    for (const wrap of gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)) {
      const record = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (!record || original(record) !== wanted) continue;
      const rect = (wrap.querySelector('.b-gantt-task') ?? wrap).getBoundingClientRect();
      if (rect.width > 0) return { x: rect.left + rect.width / 2 - width / 2, y: height / 2 - rect.top - rect.height / 2, w: rect.width, d: rect.height };
    }
    const { x, y, w, d } = barRectFor(wanted);
    return { x, y, w, d };
  }

  /** High over a room, looking straight down and square to the chart, so the move carries straight on from it. */
  const highOver = (piece: Piece, room: Pose): Pose => ({ x: piece.plot.x, y: piece.plot.y, z: 0, azimuth: 0, elevation: 0.03, distance: room.distance * 3.1 });

  /** Runs the fall toward the room (1) or back out to the chart (0), from wherever it is now. */
  function runFall(target: 0 | 1, after?: () => void): void {
    const current = fall;
    if (!current) return;
    stopTransition?.();
    const seconds = (target === 1 ? FALL_SECONDS : ESCAPE_SECONDS) * Math.abs(target - current.value);
    const controls = animate(current.value, target, {
      duration: Math.max(0.01, seconds),
      ease: 'linear',
      onUpdate: (value: number) => {
        current.value = value;
        if (target === 1 && value > 0.84) showPanels();
        context.wake();
      },
      onComplete: () => {
        current.value = target;
        if (target === 1) {
          pose = current.room;
          endFall();
          showPanels();
          if (planWaiting) planChanged();
        }
        after?.();
        context.wake();
      },
    });
    stopTransition = () => controls.stop();
  }

  /** Sets up the way through the bar, in the style of this visit. */
  function startFall(value: number, piece: Piece, room: Pose, record: TaskModel): void {
    const bar = barOnChart(record);
    const high = highOver(piece, room);
    // The color is the bar's own.
    const wrap = [...gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)].find((item) => {
      const found = gantt.resolveTaskRecord(item) as TaskModel | null;
      return found && original(found) === original(record);
    });
    const painted = wrap ? getComputedStyle(wrap.querySelector('.b-gantt-task') ?? wrap).backgroundColor : '';
    light.style.background = painted && !/rgba\(.*, 0\)|transparent/.test(painted) ? painted : cssColorText(piece.barColor);
    fall = { value, bar, room, high };
  }

  function endFall(): void {
    fall = null;
    light.hidden = true;
    context.sheetTransform(null);
    camera.near = 10;
    camera.updateProjectionMatrix();
  }

  /** Back up through the bar. It starts from wherever the camera is, and the chart is ready behind the light. */
  async function fallBackOut(piece: Piece, finish: () => void): Promise<void> {
    if (fall) {
      runFall(0, finish);
      return;
    }
    const room = pose ?? poseForWork(piece);
    context.sheetOpacity(1);
    context.sheetTransform(1, 0, 0);
    await revealBar(piece.site.record);
    startFall(1, piece, room, piece.site.record);
    runFall(0, finish);
  }

  /** Finds the camera that frames these points in the free space, by looking through it and correcting what it sees. */
  function fitPoints(points: readonly Vector3[], start: { x: number; y: number; z: number }, azimuth: number, elevation: number, fov = FOV): Pose {
    const { width, height } = context.size();
    const probeCamera = camera.clone();
    probeCamera.fov = fov;
    probeCamera.aspect = width / height;
    probeCamera.updateProjectionMatrix();
    const fitted: Pose = { ...start, azimuth, elevation, distance: restDistance(height) };
    const point = new Vector3();
    const halfView = Math.tan((probeCamera.fov * Math.PI) / 360);
    // The window, in the camera's terms, less what the diary, the trail and the controls cover.
    const diaryWidth = (context.panel.isOpen() ? context.panel.width() : diary.getBoundingClientRect().width) + 28;
    const barHeight = bar.getBoundingClientRect().height + 22;
    const navHeight = nav.getBoundingClientRect().height + 20;
    const [left, right, bottom, top] = [-0.98, 1 - (2 * diaryWidth) / width, -1 + (2 * barHeight) / height, 1 - (2 * navHeight) / height];
    for (let step = 0; step < 24; step++) {
      placeCamera(probeCamera, fitted);
      let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const corner of points) {
        point.copy(corner).project(probeCamera);
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
      const offX = (minX + maxX) / 2 - (left + right) / 2;
      const offY = (minY + maxY) / 2 - (bottom + top) / 2;
      fitted.x += Math.cos(azimuth) * offX * fitted.distance * halfView * probeCamera.aspect - (Math.sin(azimuth) * offY * fitted.distance * halfView) / Math.cos(elevation);
      fitted.y += Math.sin(azimuth) * offX * fitted.distance * halfView * probeCamera.aspect + (Math.cos(azimuth) * offY * fitted.distance * halfView) / Math.cos(elevation);
      fitted.distance *= Math.max((maxX - minX) / (right - left), (maxY - minY) / (top - bottom)) ** 0.7;
    }
    return fitted;
  }

  const boxCorners = (cx: number, cy: number, w: number, d: number, tall: number): Vector3[] =>
    [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [0, tall].map((z) => new Vector3(cx + (x * w) / 2, cy + (y * d) / 2, z))));

  function fitPose(): Pose {
    return fitPoints(boxCorners(0, 0, boardSize.w, boardSize.d, BOARD_WALL), { x: 0, y: 0, z: 0 }, -0.32, 0.92);
  }

  function poseForWork(piece: Piece): Pose {
    const [w, d] = roomSize(piece.plot);
    const { x, y } = piece.plot;
    // With the track in front and room over the walls for the sky.
    return fitPoints(boxCorners(x, y - 24, w, d + 48, roomHeightOf(piece) + 60), { x, y, z: 60 }, ROOM_AZIMUTH, ROOM_ELEVATION, ROOM_FOV);
  }

  function clear(): void {
    if (root) {
      // Put each model's own materials back first, so they get disposed with it.
      for (const piece of pieces) {
        for (const entry of piece.ghosts) entry.mesh.material = entry.real;
      }
      threeScene.remove(root);
      disposeDeep(root);
    }
    root = null;
    for (const material of extraMaterials) {
      (material as MeshBasicMaterial).map?.dispose();
      material.dispose();
    }
    extraMaterials = [];
    for (const material of [laneMaterials?.ahead, laneMaterials?.done, laneMaterials?.lit]) {
      material?.map?.dispose();
      material?.dispose();
    }
    laneMaterials = null;
    pieces = [];
    lanes = [];
    gems = [];
    phaseBars = [];
    boardMaterials = [];
    pose = null;
    hovered = null;
    railHover = null;
    pinned = null;
    handed = false;
    shot = null;
    home = null;
    focus = null;
    focusU = 0;
    boardWalls = null;
    graphPaper = null;
    dateBoard = null;
    endFall();
    light.remove();
    front = null;
    flowline?.destroy();
    flowline = null;
    flowlineWorks = [];
    fromChart = false;
    wanted = null;
    endSpotlight();
    caption.remove();
    boardBackWall = null;
    boardSideWall = null;
    phasePlates = [];
    milestonePlates = [];
    stopRailMove?.();
    stopGlide?.();
    camera.fov = FOV;
    camera.near = 10;
    camera.updateProjectionMatrix();
    context.setAtmosphere(0, 1);
    plateLayer.replaceChildren();
    plateLayer.remove();
    roomLayer.replaceChildren();
    roomLayer.remove();
    nothing = null;
    scene = { kind: 'chart' };
    for (const wrap of slotted) wrap.classList.remove('fx3d-slot');
    slotted = [];
    rail?.destroy();
    rail = null;
    tags.replaceChildren();
    bar.remove();
    nav.remove();
    diary.remove();
    tags.remove();
    card.remove();
    offer.remove();
    offer.hidden = true;
    stopMorph?.();
    hoveredTile = null;
    pickedAt = null;
    bar.classList.remove('is-shown');
    nav.classList.remove('is-shown');
    diary.classList.remove('is-shown');
    renderer.shadowMap.autoUpdate = true;
  }

  function close(after?: () => void): void {
    if (!root || closing) return;
    closing = true;
    context.panel.close(true);
    offer.hidden = true;
    stopTransition?.();
    pause();
    // Back the way it came, from wherever the camera is now, to where each bar is now.
    if (handed) pose = context.takeFromControls();
    handed = false;
    shot = null;
    stopGlide?.();
    keptDate = now;
    keptLens = lens;
    keptWork = focus && after ? focus.site.record : null;
    for (const piece of pieces) piece.from = barRectFor(piece.site.record);
    document.documentElement.classList.remove('fx3d-panels');
    bar.classList.remove('is-shown');
    nav.classList.remove('is-shown');
    diary.classList.remove('is-shown');
    card.hidden = true;
    tags.replaceChildren();
    roomLayer.replaceChildren();
    plateLayer.classList.add('is-leaving');
    for (const piece of pieces) {
      if (piece.stage) piece.stage.labels = [];
    }
    const finish = (): void => {
      plateLayer.classList.remove('is-leaving');
      clear();
      s = 0;
      closing = false;
      context.setLive(false);
      context.wake();
      after?.();
    };
    if (reducedMotion) {
      finish();
      return;
    }
    // From a piece of work, the way out is back up through its bar.
    if (focus) {
      flowline?.destroy();
      flowline = null;
      void fallBackOut(focus, finish);
      return;
    }
    if (slotted.length === 0) {
      slotted = [...gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)];
      for (const wrap of slotted) wrap.classList.add('fx3d-slot');
    }
    flowline?.destroy();
    flowline = null;
    const controls = animate(s, 0, {
      duration: CLOSE_SECONDS * s,
      ease: 'linear',
      onUpdate: (value: number) => {
        s = value;
        shadowsMoving = 1;
        context.wake();
      },
      onComplete: finish,
    });
    stopTransition = () => controls.stop();
  }

  // ---------------------------------------------------------------------------------------
  // Every frame
  // ---------------------------------------------------------------------------------------

  /** How much of the real model shows: nothing until it starts, or only its machine if that is on site first. */
  function setRealMode(piece: Piece, mode: Piece['realMode']): void {
    if (piece.realMode === mode || !piece.kit) return;
    piece.realMode = mode;
    piece.kit.root.visible = mode !== 'hidden';
    for (const entry of piece.ghosts) {
      const hide = mode === 'machine' && !entry.machine && nothing;
      entry.mesh.material = hide ? nothing! : entry.real;
      entry.mesh.castShadow = hide ? false : entry.casts;
    }
    shadowsMoving = 1;
  }

  /** The money so far: each layer as thick as what has gone out on it, one on top of the other. */
  function updateBars(piece: Piece, bars: MoneyBars, dt: number): void {
    let z = 0;
    for (const segment of bars.segments) {
      segment.shown = damp(segment.shown, segment.height, 5, dt);
      const thick = lineShare(piece, segment.line) * segment.shown;
      segment.fill.visible = thick > 0.05;
      segment.fill.position.z = z;
      segment.fill.scale.z = Math.max(0.01, thick);
      z += thick;
    }
    bars.shellShown = damp(bars.shellShown, bars.top, 5, dt);
    bars.shell.scale.z = Math.max(0.5, bars.shellShown - MONEY_GAP);
  }

  function setStanding(group: Group, u: number): void {
    group.visible = u > 0.01;
    if (group.visible) group.scale.z = Math.max(0.01, easeOut(Math.min(1, u)));
  }

  function update(dt: number, time: number): Pose | null {
    const { height } = context.size();
    if (!pose) return restPose(height);
    if (wanted && !opening && !closing && !fall && s >= 1) {
      const taskIds = wanted;
      wanted = null;
      show(taskIds);
    }
    const falling = fall ? fallStage(fall.value) : null;
    const overChart = falling?.stage === 'chart';
    if (fall && falling) {
      const { width } = context.size();
      if (falling.stage === 'chart') {
        const over = overBar(falling.t);
        pose = { x: fall.bar.x * over, y: fall.bar.y * over, z: dropHeight(falling.t, restDistance(height)) - 100, azimuth: 0, elevation: 0, distance: 100 };
        light.style.opacity = String(colorOverChart(pose.z + pose.distance, fillHeight(fall.bar, Math.tan((FOV * Math.PI) / 360), width / height)));
        light.hidden = false;
      } else {
        pose = mixPose(fall.high, fall.room, easeOut(falling.t));
        // It keeps looking down until nearly there, then the horizon comes up, and the sky with it.
        pose.elevation = lerp(fall.high.elevation, fall.room.elevation, smooth(within(falling.t, 0.2, 1)));
        const shown = colorOverRoom(falling.t);
        light.style.opacity = String(shown);
        light.hidden = shown <= 0;
      }
      shadowsMoving = 1;
    }
    if (root) root.visible = !overChart;
    // Choreographed in and out; once it lands the camera is the person's, until a scene needs it again.
    if (shot) {
      shot.t = Math.min(1, shot.t + dt / shot.seconds);
      pose = mixPose(shot.from, shot.to, inOut(shot.t));
      if (shot.t >= 1) shot = null;
    }
    if (s >= 1 && !closing && !handed && !shot && !fall) {
      context.handToControls(pose, focus ? undefined : boardSize, focus ? 0 : (home?.distance ?? 0));
      handed = true;
    }
    // The camera waits a moment on opening, so the bars are seen lifting off the chart it is still looking at.
    const result = handed ? null : mixPose(restPose(height), pose, inOut(within(s, 0.08, 1)));

    // Once its bars are in the air the chart gives way to the board's paper, light into light, and the dark
    // table comes up around the paper only after that, so nothing dips through dark on the way.
    if (!fall) context.sheetOpacity(1 - smooth(within(s, 0.2, 0.42)));
    const paperShown = smooth(within(s, 0.12, 0.34));
    const shown = smooth(within(s, 0.34, 0.62));
    // Leaving a room goes up through its bar with the room still around it, so this holds until the end.
    const inRoom = focus ? 1 : 0;
    focusU = reducedMotion ? inRoom : damp(focusU, inRoom, 3.2, dt);
    if (Math.abs(focusU - inRoom) > 0.002) shadowsMoving = 1;
    // The chart's own lens until the camera is through it.
    const fov = overChart ? FOV : lerp(FOV, ROOM_FOV, focusU);
    // The near plane follows the camera: it is what keeps depth accurate enough for surfaces close together.
    const near = overChart ? 1 : Math.max(10, Math.min(260, camera.position.z * 0.1));
    if (Math.abs(camera.fov - fov) > 0.001 || Math.abs(camera.near - near) > near * 0.1) {
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const [paper, boardEdge] = boardMaterials;
    if (paper) paper.opacity = paperShown;
    if (boardEdge) boardEdge.opacity = shown;
    // When one piece of work has the floor, the board becomes a plan on graph paper around it.
    graphPaper?.set(smooth(focusU) * shown);
    context.showTable(0, 0, -23, boardReach * 1.6, overChart ? 0 : shown, focusU);
    context.setAtmosphere(overChart ? 0 : focusU * shown, focus ? camera.position.distanceTo(tagPoint.set(focus.plot.x, focus.plot.y, 0)) : 1000);
    if (boardWalls) {
      const rise = easeOut(within(s, 0.5, 0.96)) * (1 - focusU);
      boardWalls.visible = rise > 0.005;
      boardWalls.scale.z = Math.max(0.001, rise);
      if (boardBackWall) boardBackWall.visible = camera.position.y < boardSize.d / 2;
      if (boardSideWall) boardSideWall.visible = camera.position.x < boardSize.w / 2;
    }
    tags.style.opacity = String(1 - focusU);
    plateDim = reducedMotion ? 1 : damp(plateDim, lensChanging ? 0 : 1, 22, dt);
    if (lensChanging && plateDim < 0.08) {
      lensChanging = false;
      refreshPlates();
    }
    plateLayer.style.opacity = String(smooth(within(s, 0.72, 0.96)) * (1 - focusU) * plateDim);
    roomLayer.style.opacity = String(smooth(within(focus?.roomU ?? 0, 0.7, 1)) * plateDim);
    const laneShown = smooth(within(s, 0.66, 0.94)) * lerp(1, 0.2, focusU);
    for (const lane of lanes) lane.mesh.visible = laneShown > 0.01;
    if (laneMaterials) {
      for (const material of [laneMaterials.ahead, laneMaterials.done, laneMaterials.lit]) material.opacity = laneShown;
      if (!reducedMotion) {
        // The road only moves where the work has already passed; what lies ahead stays still until it is reached.
        laneMaterials.done.map!.offset.x = -((time * 0.9) % 1);
        laneMaterials.lit.map!.offset.x = -((time * 0.9) % 1);
      }
    }

    let moving = shadowsMoving > 0.001 || s < 1;
    const quietColor = cssColor(tokenColor('--gray-200'));
    for (const piece of pieces) {
      const { site, plot } = piece;
      // From bar to box: it lifts off the chart and takes on thickness, arcs across to its plot growing as it
      // goes, and settles. Each one leaves a little after the one before it, in the order of the plan. Run
      // backward this is the landing, and it ends exactly on the bar.
      const fly = within(s, 0.01 + piece.delay * 0.2, 0.66 + piece.delay * 0.2);
      const liftOff = smooth(within(fly, 0, 0.2));
      const travel = inOut(within(fly, 0.1, 0.9));
      const grow = inOut(within(fly, 0.34, 0.96));
      const landed = smooth(within(fly, 0.86, 1));
      const isFocus = focus === piece;
      const wantRoom = isFocus && !closing && !overChart ? 1 : 0;
      piece.roomU = reducedMotion ? wantRoom : damp(piece.roomU, wantRoom, 3.2, dt);
      if (Math.abs(piece.roomU - wantRoom) > 0.002) shadowsMoving = 1;
      const [roomW, roomD] = roomSize(plot);
      const floorW = lerp(plot.w, roomW, piece.roomU);
      const floorD = lerp(plot.d, roomD, piece.roomU);
      const nudge = (hovered === piece || railHover === site.record || spotlit.has(piece) ? 6 : 0) * landed;
      piece.group.position.set(lerp(piece.from.x, plot.x, travel), lerp(piece.from.y, plot.y, travel), liftOff * (1 - travel) * 42 + Math.sin(Math.PI * travel) * 170 + nudge);
      // A bar the chart cannot show grows out of the chart's edge, and shrinks back into it.
      const inSight = piece.from.outOfSight ? smooth(within(fly, 0.04, 0.36)) : 1;
      piece.group.visible = inSight > 0.002;
      piece.group.scale.setScalar(Math.max(0.002, inSight));
      // Low enough to read as lines on the sheet, and just proud of it so they show.
      const sunk = isFocus ? 1 : lerp(1, 0.24, focusU);
      piece.body.scale.set(lerp(piece.from.w, floorW, grow) / plot.w, lerp(piece.from.d, floorD, grow) / plot.d, lerp(0.04, 1, smooth(within(fly, 0, 0.28))) * sunk);
      if (piece.face && piece.faceMaterial) {
        piece.face.scale.set(lerp(piece.from.w, plot.w, grow), lerp(piece.from.d, plot.d, grow), 1);
        piece.face.position.z = PLINTH * piece.body.scale.z + 0.25;
        piece.faceMaterial.opacity = 1 - smooth(within(fly, 0.26, 0.5));
        piece.face.visible = piece.faceMaterial.opacity > 0.01;
      }
      // Around a room the other plots go down into the ground; in the room the day track takes over from the strip.
      piece.dressing.visible = landed > 0.01 && (isFocus || focusU < 0.97);
      piece.dressing.scale.z = Math.max(0.01, landed);
      if (piece.idleStrip) {
        // Any idle days left stay as long as the strip says; none left, and it rolls away.
        const idleLeft = site.days.some((day) => day.kind === 'idle') ? 1 : 0;
        piece.idleU = damp(piece.idleU, idleLeft, 5, dt);
        piece.idleStrip.visible = focusU < 0.99 && piece.idleU > 0.01;
        piece.idleStrip.scale.x = Math.max(0.001, (1 - focusU) * piece.idleU);
      }
      for (const mark of piece.edgeMarks) mark.visible = (isFocus ? piece.roomU : focusU) < 0.3;
      if (piece.slackStrip) {
        piece.slackU = damp(piece.slackU, showing.slack && !focus ? 1 : 0, 7, dt);
        piece.slackStrip.visible = piece.slackU > 0.01;
        // It unrolls from the plot's edge.
        const unrolled = (piece.slackStrip.userData.length as number) * piece.slackU;
        piece.slackStrip.scale.x = Math.max(0.001, unrolled);
        piece.slackStrip.position.x = plot.dir * (plot.w / 2 + unrolled / 2);
      }
      piece.body.visible = isFocus || focusU < 0.97;
      const modelSize = MODEL_SCALE * lerp(1, modelGrowth(piece), piece.roomU);
      piece.kit?.root.scale.setScalar(modelSize);
      piece.ghostKit?.scale.setScalar(modelSize);
      const look = showing.crew && !focus ? piece.crewLook : null;
      piece.rim.color.lerp(look?.bar ?? piece.barColor, 1 - Math.exp(-8 * dt)).lerp(planLine, isFocus ? 0 : focusU);
      if (piece.keel) piece.keel.color.lerp((look?.bar ?? piece.barColor).clone().lerp(keelDark, 0.45), 1 - Math.exp(-8 * dt));
      if (piece.room) {
        piece.room.visible = piece.roomU > 0.005;
        piece.room.scale.z = Math.max(0.001, easeOut(piece.roomU));
      }

      const { progress } = piece;
      const active = progress.state === 'active';
      const done = progress.state === 'done';
      const { facts } = site;
      const machineHere = facts.machines.length > 0 && now >= facts.rulerStart.getTime() && now < Math.max(facts.rulerEnd.getTime(), facts.end.getTime());
      const hasIssue = site.issues.length > 0;
      const here = landed > 0.5;
      // Inside one piece of work the lens gives way, and the rest of the board folds flat around it.
      const onBoard = !focus;

      // What each lens wants standing on this plot.
      const wantWork = here && ((isFocus && lens !== 'money') || (onBoard && !piece.roomOnlyModel && (lens === 'work' || (lens === 'issues' && hasIssue)))) ? 1 : 0;
      const wantMoney = here && onBoard && lens === 'money' ? 1 : 0;
      // In its room the crew is there unless the job is finished: pale until their day comes, like the work itself.
      const wantCrew = here && ((isFocus && lens !== 'money' && (active || lens === 'crew')) || (onBoard && (lens === 'crew' || (lens === 'work' && active)))) ? 1 : 0;
      const wantBeacon = here && onBoard && lens === 'issues' && hasIssue ? 1 : 0;
      const rate = 7;
      piece.u.work = damp(piece.u.work, wantWork, rate, dt);
      piece.u.money = damp(piece.u.money, wantMoney, rate, dt);
      piece.u.crew = damp(piece.u.crew, wantCrew, rate, dt);
      piece.u.beacon = damp(piece.u.beacon, wantBeacon, rate, dt);
      // Work someone was just brought to breathes for a few seconds, so the eye finds it.
      const pointedAt = spotlit.has(piece) ? 0.65 + 0.35 * Math.sin(time * 4.5) : 0;
      piece.u.hover = damp(piece.u.hover, hovered === piece || railHover === site.record ? 1 : pointedAt, 12, dt);
      if (Math.abs(piece.u.work - wantWork) + Math.abs(piece.u.money - wantMoney) + Math.abs(piece.u.beacon - wantBeacon) > 0.002) moving = true;

      // The model follows the date, or in its room what has been reported done: pale ahead of its start, its machine there first if it is on rent.
      const modelProgress = isFocus && lens === 'work' && modelShows === 'reported' ? reportedProgress(facts.percent, progress) : progress;
      const modelDone = modelProgress.state === 'done';
      const target = modelDone ? 1 : modelProgress.state === 'active' ? modelProgress.built : 0;
      piece.shown = reducedMotion ? target : damp(piece.shown, target, 9, dt);
      if (Math.abs(piece.shown - target) > 0.002) moving = true;
      if (piece.kit) {
        const ahead = modelProgress.state === 'ahead';
        setRealMode(piece, !ahead ? 'full' : machineHere ? 'machine' : 'hidden');
        if (!ahead || machineHere) piece.kit.update({ work: ahead ? 0 : piece.shown, idle: machineHere && (ahead || modelDone), time });
      }
      if (piece.ghostKit) {
        // Solid pale ahead of its start, thinning out while the real work is built inside it, gone when done.
        const wantedGhost = modelProgress.state === 'ahead' ? 1 : modelDone ? 0 : 0.26;
        piece.ghostMaterial.opacity = reducedMotion ? wantedGhost : damp(piece.ghostMaterial.opacity, wantedGhost, 6, dt);
        piece.ghostKit.visible = piece.ghostMaterial.opacity > 0.015;
        if (Math.abs(piece.ghostMaterial.opacity - wantedGhost) > 0.01) moving = true;
      }
      setStanding(piece.work, piece.u.work);

      if (piece.money) {
        setStanding(piece.money.group, piece.u.money);
        if (piece.money.group.visible) updateBars(piece, piece.money, dt);
      }

      setStanding(piece.crew, piece.u.crew);
      piece.crewMarks.visible = onBoard && lens === 'crew';
      const crewVisible = piece.u.crew > 0.01;
      // People keep to the scale of the scene: large enough to read on the board, true to the model in a room.
      const personHeight = lerp(WORKER_HEIGHT, ROOM_WORKER, piece.roomU);
      piece.workers.forEach((worker, index) => {
        const inView = crewVisible && (isFocus || lens === 'crew' || index < 3);
        worker.root.visible = inView;
        if (!inView) return;
        worker.resize(personHeight);
        worker.setOnSite(active);
        // In a room each person moves every frame; across the board they are small, and every few frames reads the
        // same. While the board itself is moving they keep up with it.
        if (!reducedMotion) worker.update(dt, isFocus || s < 1 || closing || fall || focusU > 0.001 ? 1 : lens === 'crew' ? 4 : 3);
      });
      if (piece.beacon) {
        const live = site.issues.some((issue) => now >= issue.from && now < issue.to);
        const mast = piece.beacon.group.children[0]!;
        const lamp = piece.beacon.group.children[1]!;
        // Low, so it marks its plot without standing in front of the row behind.
        mast.scale.z = Math.max(0.01, piece.u.beacon * 58);
        lamp.position.z = piece.u.beacon * 66;
        lamp.scale.setScalar(Math.max(0.001, piece.u.beacon * (live ? 1 : 0.62)));
        piece.beacon.group.visible = piece.u.beacon > 0.01;
        piece.beacon.light.emissiveIntensity = live ? 0.9 + (reducedMotion ? 0 : 0.8 * Math.max(0, Math.sin(time * 4))) : 0;
      }
      if (piece.gate) {
        // A barrier across the road on the board; in a room the panel and the wall say what holds the work back.
        piece.gate.visible = Boolean(facts.constraint?.holdsStart) && piece.roomU < 0.5;
        const arm = piece.gate.getObjectByName('arm');
        const open = facts.constraint && now >= facts.constraint.date.getTime() ? 1 : 0;
        if (arm) arm.rotation.x = damp(arm.rotation.x, open * 1.35, 6, dt);
      }
      if (piece.puck) {
        // A marker on the board; in a room, the panel says where the payment stands.
        piece.puck.visible = piece.roomU < 0.5;
        if (site.payout.state === 'moving' && !reducedMotion) piece.puck.position.z = PLINTH + Math.max(0, Math.sin(time * 3)) * 5;
      }

      // The plot wears the look its bar has on this date.
      const wanted = focus && !isFocus ? planPaper : onBoard && (lens === 'money' || (lens === 'issues' && !hasIssue)) ? quietColor : done ? (look?.done ?? piece.doneColor) : active ? (look?.bar ?? piece.barColor) : (look?.ghost ?? piece.ghostColor);
      piece.shell.color.lerp(wanted, 1 - Math.exp(-8 * dt));
      piece.shell.emissive.copy(piece.barColor);
      piece.shell.emissiveIntensity = 0.45 * piece.u.hover;
      // Its band says it is planned to be under way, on the board: the plan doesn't say how far along.
      piece.band.visible = active && piece.roomU < 0.5 && lens !== 'money';
      piece.check.visible = facts.percent >= 100;

      const roomStage = piece.stage;
      if (roomStage) {
        roomStage.floor.visible = piece.roomU > 0.005;
        roomStage.floor.scale.setScalar(Math.max(0.001, piece.roomU));
      }
      if (roomStage && piece.room?.visible) {
        const stage = roomStage;
        const startsAt = facts.start.getTime();
        // The site is set up once the machine is here, or a few days ahead of the crew.
        stage.set.update(modelProgress, machineHere || now >= startsAt - 3 * DAY_MS, dt);
        // A wall between the camera and the work steps aside, as in any cutaway.
        stage.backWall.visible = camera.position.y < piece.group.position.y + roomD / 2;
        stage.sideWall.visible = camera.position.x < piece.group.position.x + roomW / 2;
        stage.set.group.visible = lens !== 'money' && lens !== 'crew';
        stage.track.update(now);
        if (stage.money) {
          stage.money.u = damp(stage.money.u, lens === 'money' ? 1 : 0, rate, dt);
          setStanding(stage.money.bars.group, stage.money.u);
          if (stage.money.bars.group.visible) updateBars(piece, stage.money.bars, dt);
          if (Math.abs(stage.money.u - (lens === 'money' ? 1 : 0)) > 0.002) moving = true;
        }
        if (stage.crewMarks) stage.crewMarks.visible = lens === 'crew';
        stage.pinsU = damp(stage.pinsU, lens === 'issues' ? 1 : 0, rate, dt);
        for (const pin of stage.pins) {
          const live = now >= pin.from && now < pin.to;
          setStanding(pin.group, stage.pinsU);
          pin.lamp.emissiveIntensity = live ? 0.9 + (reducedMotion ? 0 : 0.8 * Math.max(0, Math.sin(time * 4))) : 0.1;
        }
        if (piece.money) piece.money.group.visible = false;
      }
    }

    if (front) {
      front.u = damp(front.u, showing.front && !focus && !closing && s > 0.9 ? 1 : 0, 6, dt);
      const at = front.route.at(now);
      front.marker.rise(front.u);
      front.marker.place(at.x, at.y, Math.atan2(camera.position.x - at.x, -(camera.position.y - at.y)));
      if (Math.abs(front.u - (showing.front && !focus ? 1 : 0)) > 0.002) moving = true;
      if (playing || front.u < 0.999) moving = true;
    }

    for (const phase of phaseBars) {
      const total = phase.tasks.reduce((sum, piece) => sum + piece.site.facts.duration, 0);
      const built = phase.tasks.reduce((sum, piece) => sum + (piece.progress.state === 'done' ? piece.site.facts.duration : 0), 0);
      // They arrive with the board, unrolling from where the phase begins, and roll back up inside a work.
      const unroll = easeOut(within(s, 0.62, 0.95)) * (1 - focusU);
      phase.track.visible = unroll > 0.01;
      phase.track.scale.x = Math.max(0.001, unroll);
      phase.fill.visible = unroll > 0.01;
      phase.fill.scale.x = Math.max(0.01, (total > 0 ? built / total : 0) * phase.width * unroll);
    }

    for (const gem of gems) {
      const u = easeOut(within(s, 0.72, 1));
      const reached = now >= gem.at;
      gem.group.visible = !focus || focusU < 0.6;
      gem.post.scale.z = Math.max(0.01, u * 110);
      gem.stone.position.z = 9 + u * 130;
      gem.stone.scale.setScalar(Math.max(0.001, u * (reached ? 1 : 0.7)));
      gem.stone.rotation.z = reached && !reducedMotion ? time * 0.5 : 0;
      gem.post.visible = u > 0.01;
      gem.stone.visible = u > 0.01;
    }

    for (const lane of lanes) {
      const lit = (hovered !== null && (lane.from === hovered.site.record || lane.to === hovered.site.record)) || lane.from === railHover || lane.to === railHover || (focus !== null && (lane.from === focus.site.record || lane.to === focus.site.record));
      if (laneMaterials) lane.mesh.material = lit ? laneMaterials.lit : now >= lane.doneAt ? laneMaterials.done : laneMaterials.ahead;
    }

    rail?.highlight(hovered?.site.record ?? railHover ?? focus?.site.record ?? null);

    // A shadow map costs a full pass over the board: only redraw it when the board has changed, and a few
    // times a second for machines working on their own.
    shadowTick += dt;
    const working = pieces.some((piece) => piece.progress.state === 'active' && piece.kit);
    // While the date plays everything counts as moving, but a shadow pass every frame doubles the work for nothing seen.
    if (playing ? shadowTick > 0.12 : moving || (working && shadowTick > 0.2)) {
      renderer.shadowMap.needsUpdate = true;
      shadowTick = 0;
    }
    shadowsMoving = damp(shadowsMoving, 0, 3, dt);
    if (shadowsMoving < 0.01) shadowsMoving = 0;
    return result;
  }

  /**
   * What a plot's one label says: the same place, about the same size, answering what this lens asks. There is
   * only ever one label to a plot, which is what keeps the board calm as the lens changes.
   */
  function plateLines(piece: Piece): PlateLine[] {
    const { currency } = look();
    const money = (minor: number): string => compactMoney(minor, currency);
    const short = (date: Date): string => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const { site, progress } = piece;
    const { facts } = site;
    const lastDay = new Date(facts.end.getTime() - 1);
    const name: PlateLine = { text: `${facts.wbs ? `${facts.wbs} ` : ''}${facts.name}`, from: 0 };
    const rental = rentalLine(site);
    if (lens === 'money') {
      const cost = site.money;
      if (!cost || (cost.expected <= 0 && cost.budget <= 0)) return [name];
      const idle = idleSoFar(site);
      const over = cost.budget > 0 && cost.expected > cost.budget;
      const lines: PlateLine[] = [name, { text: money(cost.expected), from: 0, ...(over ? { tone: 'danger' as const } : {}) }];
      for (const line of site.costs) if (line.kind !== 'idle') lines.push({ text: `${line.who} ${money(line.minor)}`, from: 2, dot: paintOf(line.color) });
      if (idle > 0) lines.push({ text: `${spentWords(money(idle))} idle`, from: 0, tone: 'caution' });
      const words: Record<string, string> = { paid: 'Paid by PayPal', moving: 'PayPal is processing', ready: 'Ready to pay', failed: 'Payment failed' };
      if (words[site.payout.state]) lines.push({ text: words[site.payout.state]!, from: 0, tone: site.payout.state === 'failed' ? 'danger' : 'paypal' });
      if (cost.budget > 0) lines.push({ text: `Budget ${money(cost.budget)}`, from: 1 });
      if (rental) lines.push({ text: `${facts.machine ?? 'Machine'}: ${rental}`, from: 2 });
      return lines;
    }
    if (lens === 'crew') {
      const [first, ...others] = facts.crews;
      if (!first) return [name, { text: 'No crew assigned', from: 0 }];
      const when = progress.state === 'active' ? 'Planned on site' : progress.state === 'done' ? 'Planned to be done' : `Planned from ${short(facts.start)}`;
      return [
        name,
        { text: `${facts.crews.some((crew) => crew.usual) ? 'About ' : ''}${site.people} ${site.people === 1 ? 'person' : 'people'} · ${when}`, from: 0, ...(progress.state === 'active' ? { tone: 'strong' as const } : {}) },
        { text: first.name, from: 1, dot: first.color },
        ...others.map((crew): PlateLine => ({ text: crew.name, from: 1, dot: crew.color })),
      ];
    }
    if (lens === 'issues') {
      const lines: PlateLine[] = [name];
      site.issues.forEach((issue, index) => lines.push({ text: issue.text, from: index === 0 ? 0 : 1, tone: issue.tone }));
      if (site.knockOnDays > 0) lines.push({ text: `${site.knockOnDays} days late, from the work before it`, from: 1 });
      return lines;
    }
    const when = progress.state === 'active' ? `${standingOf(progress, facts.start.getTime(), facts.end.getTime(), now)}, to ${short(lastDay)}` : progress.state === 'done' ? `Planned to be done ${short(lastDay)}` : `${short(facts.start)} to ${short(lastDay)}`;
    const lines: PlateLine[] = [name, { text: when, from: 0, ...(progress.state === 'active' ? { tone: 'strong' as const } : {}) }];
    if (progress.state === 'ahead') lines.push({ text: standingOf(progress, facts.start.getTime(), facts.end.getTime(), now), from: 1 });
    for (const crew of facts.crews) lines.push({ text: crew.name, from: 1, dot: crew.color });
    if (site.slackDays > 0) lines.push({ text: `${site.slackDays} ${site.slackDays === 1 ? 'day' : 'days'} of slack`, from: showing.slack ? 0 : 1 });
    if (site.critical) lines.push({ text: 'Critical path', from: 2 });
    if (rental) lines.push({ text: `${facts.machine ?? 'Machine'}: ${rental}`, from: 2 });
    return lines;
  }

  /** What each label on the board says on this date. Its size follows; where it goes is worked out each frame. */
  function refreshPlates(): void {
    // Inside a room the board's labels are out of sight, and the way back to the board writes them anew.
    if (scene.kind === 'work') return;
    const { currency } = look();
    const short = (date: Date): string => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    for (const piece of pieces) {
      piece.plate?.setLines(plateLines(piece));
      if (piece.plate) {
        // In the issues lens a plot with nothing to report steps back, and one with something can be clicked.
        const hasIssue = piece.site.issues.length > 0;
        piece.plate.element.dataset.quiet = String(lens === 'issues' && !hasIssue);
        piece.plate.element.style.pointerEvents = lens === 'issues' && hasIssue ? 'auto' : 'none';
      }
    }
    for (const phase of phasePlates) {
      const lines: PlateLine[] = [{ text: phase.name, from: 0 }];
      const doneJobs = phase.tasks.filter((piece) => piece.progress.state === 'done').length;
      const forecast = phase.tasks.reduce((sum, piece) => sum + (piece.site.money?.expected ?? 0), 0);
      if (lens === 'money' && forecast > 0) {
        lines.push({ text: compactMoney(forecast, currency), from: 0 });
      } else if (lens === 'crew') {
        const firms = new Set(phase.tasks.flatMap((piece) => piece.site.facts.crews.map((crew) => crew.name)));
        lines.push({ text: `${firms.size} ${firms.size === 1 ? 'firm' : 'firms'}`, from: 0 });
      } else if (lens === 'issues') {
        const count = phase.tasks.filter((piece) => piece.site.issues.length > 0).length;
        lines.push({ text: count === 0 ? 'Nothing to act on' : `${count} ${count === 1 ? 'place' : 'places'} to act`, from: 0 });
      } else {
        lines.push({ text: `${short(new Date(phase.start))} to ${short(new Date(phase.end - 1))}`, from: 0 }, { text: `${doneJobs} of ${phase.tasks.length} jobs due`, from: 0 });
      }
      phase.plate.setLines(lines);
    }
    for (const item of milestonePlates) {
      item.plate.setLines(lens === 'issues' && item.late > 0 ? [{ text: item.name, from: 0 }, { text: `${item.late} ${item.late === 1 ? 'day' : 'days'} late`, from: 0, tone: 'danger' }] : [{ text: item.name, from: 0 }, { text: item.date, from: 0 }]);
    }
    if (dateBoard && pieces.length > 0) {
      const doneJobs = pieces.filter((piece) => piece.progress.state === 'done').length;
      const underWay = pieces.filter((piece) => piece.progress.state === 'active').length;
      const dayOfPlan = Math.max(1, Math.ceil((now - span.start) / DAY_MS));
      const totalDays = Math.max(1, Math.round((span.end - span.start) / DAY_MS));
      dateBoard.draw([
        { kind: 'title', text: new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) },
        { kind: 'line', text: `Plan day ${dayOfPlan} of ${totalDays} · ${underWay} ${underWay === 1 ? 'job' : 'jobs'} planned`, tone: 'quiet' },
        { kind: 'bar', label: 'Jobs planned to be done', value: `${doneJobs} of ${pieces.length}`, share: doneJobs / pieces.length, color: tokenColor('--ink') },
      ]);
    }
    if (front) front.tag.textContent = new Date(now).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  const plateCorner = new Vector3();
  const plateOther = new Vector3();
  /** Puts the board's labels on the screen, most important first; a label that would land on another gives way. */
  function placePlates(width: number, height: number): void {
    if (focusU > 0.98 || s < 0.7 || closing || fall) {
      for (const piece of pieces) piece.plate?.place(0, 0, false);
      for (const phase of phasePlates) phase.plate.place(0, 0, false);
      for (const item of milestonePlates) item.plate.place(0, 0, false);
      return;
    }
    const taken: Box[] = [];
    if (front && front.u > 0.5 && !front.tag.hidden) {
      const rect = front.tag.getBoundingClientRect();
      taken.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    }
    const seat = (plate: Plate, x: number, y: number): void => {
      const box: Box = { x, y, w: plate.width, h: plate.height };
      const inView = x + plate.width > 0 && x < width && y + plate.height > 0 && y < height;
      if (!inView || taken.some((other) => overlaps(box, other))) {
        plate.place(0, 0, false);
        return;
      }
      taken.push({ x: x - 2, y: y - 2, w: plate.width + 4, h: plate.height + 4 });
      plate.place(x, y, true);
    };
    const toScreen = (point: Vector3): { x: number; y: number; behind: boolean } => {
      const projected = point.project(camera);
      return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height, behind: projected.z > 1 };
    };
    /** How large one unit of the board is on the screen, around this point. */
    const pixelsPerUnit = (at: Vector3): number => {
      const a = toScreen(plateCorner.copy(at));
      const b = toScreen(plateOther.copy(at).setX(at.x + 100));
      return Math.hypot(a.x - b.x, a.y - b.y) / 100;
    };
    for (const phase of phasePlates) {
      const at = toScreen(plateCorner.copy(phase.at));
      if (at.behind) {
        phase.plate.place(0, 0, false);
        continue;
      }
      phase.plate.setLevel(plateLevel(pixelsPerUnit(phase.at)));
      seat(phase.plate, at.x, at.y);
    }
    const seatPlot = (piece: Piece): void => {
      if (!piece.plate) return;
      const { plot } = piece;
      const a = toScreen(plateCorner.set(plot.x - plot.w / 2, plot.y - plot.d / 2, PLINTH));
      const b = toScreen(plateOther.set(plot.x + plot.w / 2, plot.y - plot.d / 2, PLINTH));
      if (a.behind || b.behind) {
        piece.plate.place(0, 0, false);
        return;
      }
      piece.plate.setLevel(plateLevel(Math.hypot(a.x - b.x, a.y - b.y) / plot.w));
      const left = a.x < b.x ? a : b;
      const right = a.x < b.x ? b : a;
      const y = Math.max(a.y, b.y) + 5;
      // Zoomed in on a plot, its label stays in sight while any of its front edge does.
      const onScreen = right.x > 0 && left.x < width && y > 0 && y < height;
      seat(piece.plate, onScreen ? Math.min(width - piece.plate.width - 8, Math.max(8, left.x)) : left.x, y);
    };
    // Whatever this lens is asking about gets its say before the rest.
    const matters = (piece: Piece): boolean => (lens === 'issues' ? piece.site.issues.length > 0 : lens === 'money' ? idleSoFar(piece.site) > 0 || piece.site.payout.state !== 'none' : piece.progress.state === 'active' || piece.site.issues.length > 0);
    for (const piece of pieces) if (matters(piece)) seatPlot(piece);
    for (const piece of pieces) if (!matters(piece)) seatPlot(piece);
    for (const item of milestonePlates) {
      const at = toScreen(plateCorner.copy(item.at));
      if (!at.behind) seat(item.plate, at.x, at.y + 5);
      else item.plate.place(0, 0, false);
    }
  }

  function placeRoomLabels(width: number, height: number): void {
    const stage = focus?.stage;
    if (!focus || !stage || focus.roomU < 0.6) return;
    const taken: Box[] = [];
    for (const item of stage.labels) {
      if (item.element.hidden) continue;
      const local = item.at();
      if (!local) continue;
      tagPoint.set(focus.group.position.x + local.x, focus.group.position.y + local.y, local.z).project(camera);
      const x = ((tagPoint.x + 1) / 2) * width;
      const y = ((1 - tagPoint.y) / 2) * height;
      const size = item.element.getBoundingClientRect();
      const box: Box = { x: x - size.width / 2, y: y - size.height, w: size.width, h: size.height };
      // Two labels on one spot stack upward, rather than sit on each other.
      while (taken.some((other) => overlaps(box, other))) box.y -= size.height + 3;
      taken.push(box);
      item.element.style.transform = `translate(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px)`;
    }
  }

  /** Over the chart the page keeps pace with the camera, up to where the bar fills the view. */
  function followFall(width: number, height: number): void {
    if (!fall) return;
    const stage = fallStage(fall.value);
    const halfTan = Math.tan((FOV * Math.PI) / 360);
    if (stage.stage === 'chart') {
      // It stays drawn all the way, behind the color: a browser throws away what it has drawn of a hidden page, and
      // could not repaint it in time for the way back.
      const held = Math.max(camera.position.z, fillHeight(fall.bar, halfTan, width / height));
      const scale = restDistance(height) / held;
      context.sheetOpacity(1);
      context.sheetTransform(scale, -camera.position.x * scale, camera.position.y * scale);
    } else if (closing) {
      // On the way out it is drawn behind the opaque room too, so it is whole by the time the camera reaches it.
      context.sheetOpacity(1);
      context.sheetTransform(1, 0, 0);
    } else {
      context.sheetOpacity(0);
      context.sheetTransform(null);
    }
  }

  function placeFrontTag(width: number, height: number): void {
    if (!front) return;
    front.tag.hidden = front.u < 0.5 || Boolean(flowline);
    if (front.tag.hidden) return;
    tagPoint.set(front.marker.root.position.x, front.marker.root.position.y, 76).project(camera);
    front.tag.style.transform = `translate(${(((tagPoint.x + 1) / 2) * width).toFixed(1)}px, ${(((1 - tagPoint.y) / 2) * height).toFixed(1)}px) translate(-50%, -100%)`;
  }

  function afterCamera(): void {
    const { width, height } = context.size();
    camera.updateMatrixWorld();
    followFall(width, height);
    placeFrontTag(width, height);
    placePlates(width, height);
    placeRoomLabels(width, height);
  }

  function pick(x: number, y: number): Piece | null {
    const { width, height } = context.size();
    pointer.set((x / width) * 2 - 1, 1 - (y / height) * 2);
    camera.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects(pieces.map((piece) => piece.hit), false);
    const first = hits[0]?.object;
    return first ? (pieces.find((piece) => piece.hit === first) ?? null) : null;
  }

  /** The day under the pointer on a room's track. */
  function pickTile(x: number, y: number): DayTile | null {
    const stage = focus?.stage;
    if (!stage || !focus || focus.roomU < 0.9 || lens === 'money') return null;
    const { width, height } = context.size();
    pointer.set((x / width) * 2 - 1, 1 - (y / height) * 2);
    camera.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
    const uv = ray.intersectObject(stage.track.face, false)[0]?.uv;
    return uv ? stage.track.tileAt(uv.x) : null;
  }

  /** A click on a day takes the date there: the work stands as it does then, and the label says how far along it is. */
  function pickDay(tile: DayTile): void {
    pause();
    stopGlide?.();
    pickedAt = tile.at;
    // The end of the day, so the work stands as far along as its tile says.
    const target = tile.at + DAY_MS * 0.98;
    if (reducedMotion) {
      setDate(target);
    } else {
      picking = true;
      const controls = animate(now, target, {
        duration: 0.7,
        ease: [0.3, 0, 0.1, 1],
        onUpdate: (value: number) => setDate(value),
        onComplete: () => {
          picking = false;
          // Everything was last read as the day began: now it says how far along the plan has it when the day ends.
          if (focus?.stage) focus.stage.painted = '';
          lastDay = -1;
          setDate(now);
        },
      });
      stopGlide = () => {
        controls.stop();
        picking = false;
      };
    }
    if (focus) refreshRoom(focus);
  }

  function hover(x: number, y: number): void {
    if (focus && s >= 1 && !closing) {
      const tile = pickTile(x, y);
      if (tile?.at !== hoveredTile?.at) {
        hoveredTile = tile;
        focus.stage?.track.setHover(tile?.at ?? null);
        renderer.domElement.style.cursor = tile ? 'pointer' : '';
        refreshRoom(focus);
        context.wake();
      }
      return;
    }
    if (s < 1 || closing || focus) return;
    const piece = pick(x, y);
    if (piece !== hovered) {
      hovered = piece;
      context.wake();
    }
    if (pinned) return;
    if (piece) fillCard(piece, x, y, false);
    else card.hidden = true;
  }

  function click(x: number, y: number): void {
    if (focus && s >= 1 && !closing) {
      const tile = pickTile(x, y);
      if (tile) pickDay(tile);
      return;
    }
    if (s < 1 || closing || focus) return;
    const piece = pick(x, y);
    pinned = piece;
    if (piece) {
      fillCard(piece, x, y, true);
      // With the side panel open, it follows what is clicked, as it does on the chart.
      if (context.panel.isOpen()) context.selectTask(piece.site.record);
    } else card.hidden = true;
  }

  function doubleClick(x: number, y: number): void {
    if (s < 1 || closing) return;
    // In a room, as on the chart, a double-click edits. A day on the track was just picked by the first click.
    if (focus) {
      if (!pickTile(x, y)) editWork(focus.site.record);
      return;
    }
    const piece = pick(x, y);
    if (piece) goTo({ kind: 'work', work: piece.site.record });
  }

  // ---------------------------------------------------------------------------------------
  // Being pointed at something from outside the scene
  // ---------------------------------------------------------------------------------------

  /** Asks of the app that come back as a request to show the same work are not news. */
  function quietly(run: () => void): void {
    quiet = true;
    try {
      run();
    } finally {
      quiet = false;
    }
  }

  function endSpotlight(): void {
    window.clearTimeout(spotlightTimer);
    for (const piece of spotlit) piece.plate?.element.classList.remove('is-pointed-at');
    spotlit.clear();
    caption.hidden = true;
  }

  /** Says what they were brought to, with its issues, and lets the work breathe for a few seconds. */
  function spotlight(title: string, on: readonly Piece[], notes: readonly HTMLElement[] = []): void {
    endSpotlight();
    for (const piece of on) {
      spotlit.add(piece);
      piece.plate?.element.classList.add('is-pointed-at');
    }
    const head = document.createElement('b');
    head.textContent = title;
    caption.replaceChildren(head, ...notes);
    // The same issue on several pieces of work needs saying once.
    const seen = new Set<string>();
    for (const pill of on.flatMap(issuePills)) {
      if (seen.has(pill.textContent ?? '')) continue;
      seen.add(pill.textContent ?? '');
      caption.append(pill);
    }
    offer.hidden = true;
    caption.hidden = false;
    spotlightTimer = window.setTimeout(endSpotlight, SPOTLIGHT_MS);
    context.wake();
  }

  /** A view of these places on the board, framed by the same rule as the whole board. */
  function poseAround(spots: readonly { x: number; y: number; w: number; d: number }[]): Pose {
    // With room around them, so that what they are next to is still there to go by.
    const corners = spots.flatMap((spot) => boxCorners(spot.x, spot.y, spot.w * 2 + 200, spot.d * 2 + 200, 70));
    const middle = spots.reduce((sum, spot) => ({ x: sum.x + spot.x / spots.length, y: sum.y + spot.y / spots.length }), { x: 0, y: 0 });
    return fitPoints(corners, { ...middle, z: 0 }, -0.32, 0.92);
  }

  function show(taskIds: readonly number[]): void {
    if (quiet || (!root && !opening)) return;
    if (opening || closing || fall || s < 1) {
      wanted = taskIds;
      return;
    }
    const store = gantt.project.taskStore;
    const tasks = taskIds.flatMap((id) => (store.getById(id) as TaskModel | undefined) ?? []);
    const pieceOf = (task: TaskModel): Piece | undefined => pieces.find((piece) => piece.site.record === task);
    const works = worksWithin(tasks, (task) => pieceOf(task) !== undefined);
    const next = sceneToShow(works);
    if (next) awaitedSince = 0;
    if (next?.kind === 'work') {
      const piece = pieceOf(next.work)!;
      if (focus === piece) frameScene(0.9);
      else goTo(next);
      // A machine paid for with no work planned: straight to a day of it, which is what the card was about.
      const idleDay = piece.site.idleCostMinor > 0 ? piece.site.days.find((day) => day.kind === 'idle') : undefined;
      if (idleDay) pickDay(idleDay);
      else glideDateTo(piece);
      spotlight(`${piece.site.facts.wbs ? `${piece.site.facts.wbs} ` : ''}${piece.site.facts.name}`, [piece]);
      return;
    }
    if (next) {
      const group = works.map((work) => pieceOf(work)!);
      goTo(next);
      frameScene(1.3, poseAround(group.map((piece) => piece.plot)));
      const names = group.slice(0, 3).map((piece) => piece.site.facts.name);
      spotlight(`${group.length} tasks: ${names.join(', ')}${group.length > names.length ? ', and more' : ''}`, group);
      return;
    }
    // A milestone is on the board, though it has no room of its own.
    const gem = gems.find((item) => tasks.includes(item.record));
    if (gem) {
      goTo({ kind: 'board' });
      frameScene(1.1, poseAround([{ x: gem.group.position.x, y: gem.group.position.y, w: 120, d: 120 }]));
      spotlight(`${gem.record.name ?? 'Milestone'}: ${(gem.record.startDate as Date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`, []);
      return;
    }
    const [first] = tasks;
    if (!first) return;
    // Just added: the board hasn't caught up with the plan yet, and will in a moment.
    const shouldBeHere = first.isLeaf && !first.isMilestone && first.startDate instanceof Date;
    if (shouldBeHere && performance.now() - (awaitedSince || (awaitedSince = performance.now())) < CATCH_UP_MS) {
      wanted = taskIds;
      return;
    }
    awaitedSince = 0;
    spotlight(`${first.name ?? 'That task'} isn't on the site: it has no work with dates yet.`, []);
  }

  /** The task editor, over the scene and in the room of the work it is editing. */
  function editWork(record: TaskModel): void {
    if (focus?.site.record !== record) goTo({ kind: 'work', work: record });
    quietly(() => context.editTask(record));
    context.panel.open('task');
  }

  // ---------------------------------------------------------------------------------------
  // The plan changes while this is open
  // ---------------------------------------------------------------------------------------

  /** The side panel takes the place of the diary, and the scene makes room for it. */
  function panelChanged(opening: boolean | null): void {
    if (opening !== null) document.documentElement.classList.toggle('fx3d-panel-open', opening);
    syncBar();
    if (opening !== null && root && !closing) {
      home = fitPose();
      frameScene(0.8);
    }
  }

  /** Back to the chart with the payment open; it is open before the page comes back into view. */
  function goToPayment(record: TaskModel): void {
    quietly(() => context.openPayment?.(record));
    close(() => undefined);
  }

  /** Asks once a fix has landed: how it came out, and whether to go and pay for it. */
  function offerPayment(piece: Piece): void {
    const { site } = piece;
    if (focus !== piece || !context.openPayment || site.payout.state !== 'ready' || offered.has(piece)) return;
    offered.add(piece);
    const { currency } = look();
    const icon = remyMarkElement('breath', 'fx3d-mark');
    const words = document.createElement('p');
    const machine = site.facts.machine ?? 'The machine';
    const done = piece.savedMinor > 0 ? `${machine} rental shortened, and ${wholeMoney(piece.savedMinor, currency)} saved.` : `New dates for the ${machine.toLowerCase()} are in the plan.`;
    const owed = site.payout.amountMinor ? ` ${wholeMoney(site.payout.amountMinor, currency)} is ready to pay.` : '';
    words.textContent = `${done}${owed} Go to the payment?`;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'button is-primary is-sm';
    yes.textContent = 'Go to payment';
    yes.dataset.testid = 'fx3d-offer-pay';
    yes.addEventListener('click', () => goToPayment(site.record));
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'button is-sm is-quiet';
    no.textContent = 'Stay here';
    no.addEventListener('click', () => {
      offer.hidden = true;
    });
    const actions = document.createElement('div');
    actions.className = 'fx3d-offer-actions';
    actions.append(yes, no);
    offer.replaceChildren(icon, words, actions);
    offer.hidden = false;
  }

  /** The days change in front of you: those that went close up one by one, each saying what it gave back. */
  function playNewDays(piece: Piece, gone: readonly DayTile[]): void {
    const stage = piece.stage;
    if (!stage) return;
    stopMorph?.();
    const track = stage.track;
    track.setDays(piece.site.days);
    const { currency } = look();
    const waiting = gone.map((tile, index) => ({ tile, at: gone.length > 1 ? (index / (gone.length - 1)) * 0.55 : 0 }));
    const finish = (): void => {
      track.morph(1);
      refreshRoom(piece);
      const start = middayOf(piece.site.facts.rulerStart.getTime());
      if (!playing && focus === piece && (now < piece.site.facts.rulerStart.getTime() || now >= piece.site.facts.rulerEnd.getTime())) {
        stopGlide?.();
        const glide = animate(now, start, { duration: 1, ease: [0.3, 0, 0.1, 1], onUpdate: (value: number) => setDate(value), onComplete: () => offerPayment(piece) });
        stopGlide = () => glide.stop();
      } else {
        offerPayment(piece);
      }
    };
    const controls = animate(0, 1, {
      duration: 0.9 + gone.length * 0.35,
      ease: 'linear',
      onUpdate: (t: number) => {
        track.morph(t);
        while (waiting[0] && t >= waiting[0].at) {
          const { tile } = waiting.shift()!;
          if (tile.costMinor > 0) popFromTile(piece, tile.at, `${wholeMoney(tile.costMinor, currency)} saved`, 'good');
        }
        shadowsMoving = 1;
        context.wake();
      },
      onComplete: finish,
    });
    stopMorph = () => controls.stop();
  }

  /** One piece of work takes on what the plan now says. */
  function followPlan(piece: Piece, before: SiteTask): void {
    const { site, stage, plot } = piece;
    const tiles = (days: readonly DayTile[]): string => days.map((day) => `${day.at}:${day.kind}:${day.costMinor}`).join();
    const newDays = tiles(before.days) !== tiles(site.days);
    if (piece.money) resizeBars(piece.money, site.costs);
    if (stage?.money) resizeBars(stage.money.bars, site.costs);
    // What fewer days on rent saves: a day of idle that became a day of cover is still paid for.
    const paidWithNoWork = (days: readonly DayTile[]): number => days.reduce((sum, day) => sum + day.costMinor, 0);
    const savedNow = paidWithNoWork(before.days) - paidWithNoWork(site.days);
    if (savedNow > 0) piece.savedMinor += savedNow;

    // What stands on the plot because of the plan.
    if (site.payout.state !== before.payout.state) {
      if (piece.puck) {
        piece.puck.removeFromParent();
        piece.puck.traverse((child) => {
          if (child instanceof Mesh) child.geometry.dispose();
        });
      }
      piece.puck = makePuck(site, plot, boardColors, new TextureLoader());
      if (piece.puck) piece.dressing.add(piece.puck);
    }
    if (!piece.beacon && site.issues[0]) {
      piece.beacon = makeBeacon(site, plot);
      if (piece.beacon) piece.dressing.add(piece.beacon.group);
    }
    if (site.facts.constraint?.holdsStart && !piece.gate) {
      piece.gate = makeGate(plot, boardColors.stripes!);
      piece.dressing.add(piece.gate);
    }

    // The strip on the board says how long the wait is now.
    const printed = piece.idleStrip?.children[0] as Mesh<PlaneGeometry, MeshBasicMaterial> | undefined;
    if (printed && newDays) {
      const use = rentalUse(site.days);
      if (use.idle > 0) {
        printed.material.map?.dispose();
        printed.material.map = paintIdleStrip(use.idle, `${use.idle} ${use.idle === 1 ? 'day' : 'days'} idle${site.idleCostMinor > 0 ? ` · ${spentWords(compactMoney(site.idleCostMinor, look().currency))}` : ''}`, plot.idleW, 26, { idle: tokenColor('--warning-fill'), ink: tokenColor('--ink') });
      }
    }

    if (stage) {
      stage.painted = '';
      if (before.issues.map((issue) => issue.text).join() !== site.issues.map((issue) => issue.text).join()) stage.standIssues();
      if (before.facts.start.getTime() !== site.facts.start.getTime() || before.facts.end.getTime() !== site.facts.end.getTime()) stage.paintTitle();
      if (newDays) {
        const gone = before.days.filter((day) => day.kind === 'idle' && !site.days.some((other) => other.at === day.at));
        if (focus === piece && piece.roomU > 0.6 && !reducedMotion) {
          playNewDays(piece, gone);
        } else {
          stage.track.setDays(site.days);
          stage.track.morph(1);
        }
      }
    }
    if (!newDays) offerPayment(piece);
  }

  function planChanged(): void {
    if (!root) return;
    if (opening || closing || fall) {
      planWaiting = true;
      return;
    }
    // Slack and the critical path are not to be read while the engine is working: come back when it is done.
    if (engineCommitting(gantt.project as never)) {
      setTimeout(planChanged, 160);
      return;
    }
    planWaiting = false;
    const plan = readPlan();
    if (plan.shape !== builtShape) {
      void rebuildInPlace();
      return;
    }
    const next = new Map(plan.sites.map((site) => [site.record, site]));
    for (const piece of pieces) {
      const site = next.get(piece.site.record);
      if (!site) continue;
      const before = piece.site;
      piece.site = site;
      piece.progress = progressAt(site.facts, now);
      followPlan(piece, before);
    }
    span = {
      start: Math.min(...plan.sites.map((site) => site.facts.rulerStart.getTime()), ...plan.milestones.map((task) => (task.startDate as Date).getTime())),
      end: Math.max(...plan.sites.map((site) => site.facts.rulerEnd.getTime()), ...plan.milestones.map((task) => (task.startDate as Date).getTime() + DAY_MS)),
    };
    for (const lane of lanes) lane.doneAt = (lane.from.endDate as Date).getTime();
    for (const gem of gems) gem.at = (gem.record.startDate as Date).getTime();
    for (const phase of phasePlates) {
      phase.start = Math.min(...phase.tasks.map((piece) => piece.site.facts.start.getTime()));
      phase.end = Math.max(...phase.tasks.map((piece) => piece.site.facts.end.getTime()));
    }
    for (const item of milestonePlates) {
      item.date = (item.record.startDate as Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      item.late = slipDays(item.record);
    }
    if (railBuild) railBuild();
    if (rail) {
      rail.setWindow(railWindow[0], railWindow[1]);
      fitRail();
    }
    if (front && readFrontStops) front.route = frontRoute(readFrontStops());
    if (flowWorksNow) flowlineWorks = flowWorksNow();
    if (flowline) {
      flowline.destroy();
      flowline = null;
    }
    applyShowing();
    lastDay = -1;
    setDate(now);
    context.wake();
  }

  /** What the plan now says can't be shown by what stands here: it all stands up again, with nothing else changed. */
  async function rebuildInPlace(): Promise<void> {
    const work = focus?.site.record;
    const camera = handed ? context.takeFromControls() : pose;
    const wasFromChart = fromChart;
    const saved = new Map(pieces.map((piece) => [piece.site.record, piece.savedMinor]));
    keptDate = now;
    keptLens = lens;
    const stillWanted = wanted;
    clear();
    wanted = stillWanted;
    await open(work, { camera });
    fromChart = wasFromChart && Boolean(focus);
    // The work it was in is gone, deleted from the panel, say: the camera is left close over a plot that isn't there.
    if (work && !focus) frameScene(1);
    for (const piece of pieces) piece.savedMinor = saved.get(piece.site.record) ?? 0;
    syncBar();
  }

  function resized(): void {
    if (!root || !home) return;
    // Everyone gets a fitted view back: what they had may not be on the screen any more.
    home = fitPose();
    frameScene(0.6);
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!root || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    const found = LENSES.find((item) => item.key === event.key);
    if (found) setLens(found.id);
    if (event.key === ' ' && target?.tagName !== 'BUTTON') {
      event.preventDefault();
      togglePlay();
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    open,
    close,
    up,
    lastWork: () => keptWork,
    update,
    afterCamera,
    hover,
    click,
    doubleClick,
    resized,
    planChanged,
    show,
    panelChanged,
    destroy() {
      window.removeEventListener('keydown', onKey);
      stopTransition?.();
      stopPlay?.();
      context.panel.close(true);
      clear();
    },
  };
}
