/**
 * The site view: a plan that is a building, seen as the building. The plan's rows stay where they are, on the left;
 * the chart's side turns into the building, standing on its lot on the date that is on show. One row is one piece of
 * the building: pointing at a row lights its piece and pointing at a piece names it and lights its row; choosing a row
 * (or a piece) singles it out with the rest faded back and brings the camera round to it; choosing a group singles out
 * all of its rows. The building can be taken apart, story by story, and one story lifted clear of those above it.
 *
 * Going in, the chart's bars lift off where they were drawn and fly into the building, which goes up from the ground as
 * they land; from a bar's right-click menu, the camera drops through that bar into its piece. Coming out is the same
 * move backward: the pieces fly back and set down as the bars. Every state has a visible way back: the Chart toggle in
 * the toolbar and the close button leave, each card and chip has its own close, and Esc steps back one state at a time.
 *
 * It is a SiteView, so the theater runs it like the site board; it asks the theater to put the canvas over the chart's
 * side only (`setInset`), and draws through the building stage's passes (`render`).
 */
import type { Gantt, ResourceModel, TaskModel } from '@bryntum/gantt';
import { Box3, BoxGeometry, CanvasTexture, Color, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, type Object3D, PerspectiveCamera, PlaneGeometry, Quaternion, type Raycaster as RaycasterType, Raycaster, ShadowMaterial, SRGBColorSpace, Vector2, Vector3 } from 'three';
import { compactMoney, type LookState, original, phaseClass, wholeMoney } from '../look';
import { dueDay } from '../late-payment';
import { gateIndex, paymentOf, type Gate } from '../pay-gates';
import { createBuilding, jibSway, type BuildingModel, type PaintRule } from './building';
import { type Booking, builtBy, FOUNDATIONS, idleBy, machineOn, readBuilding, roofOf, type BuildingPlan, type PlanTask } from './building-plan';
import { createStage, PAPER_COLOR, type Stage, type StageLights } from './building-stage';
import { BASE_BOTTOM, BASE_CENTER, BASE_SIZE, CRANE_AT, flyLean, FOOTPRINT, LOT } from './building-site';
import { type CalendarEmphasis, createDayCalendar, type DayCalendar } from './day-calendar';
import { type DayKind, type DayTile, dayWords } from './day-track';
import { factsOf } from './facts';
import { cssColor, tokenColor } from './page';
import { duskAt, duskStage, type DuskStage } from './dusk';
import { daysOnRent, momentWords, rentalChange, type RentalChange, type RentalDay, type RentalFacts, rentalMoment, rentalStage, type RentalStage, rentalSummary, savedWords, spendWords } from './rental-story';
import { aimFrom, aroundPose, FOV, type Lens as Optics, mixPose, onTheJib, placeCamera, type Pose, restDistance, type Spot, turnPose } from './rig';
import { crewNames, siteTasks, type SiteTask } from './site-facts';
import type { SiteContext, SiteView } from './site-view';
import { planClock } from '../../plan-clock';
import '../../styles/fx3d-building.css';
import { walkTree } from '../walk';

const DAY_MS = 86_400_000;
const SECONDS_PER_DAY = 0.12;
const MOVE_SECONDS = 1.1;
/** Once around the site from high up. */
const FLY_SECONDS = 24;
/** In through a bar, and back out onto the plan. */
const DIVE_SECONDS = 1;
/** In with no bar to go through (the toolbar's button). */
const GLIDE_SECONDS = 2.2;
const RETURN_SECONDS = 2.1;
/** Where the bar has opened all the way and the fall down the well goes on, as a share of the dive. */
const DIVE_SPLIT = 0.36;
/** The shaft the camera falls down, from the bar to the plan: deep enough for an express run. */
const WELL_DEPTH = 14000;
/** The share of the fall spent flat out, before the brakes come on. */
const WELL_RUN = 0.64;
/** The lens down the well, wider than the view's own so that its walls read. */
const WELL_LENS = 46;
/** How many of the scene's units one pixel of the chart is, on the ground the site stands on. */
const GROUND_SCALE = 1.6;
/** The ground, the plan's paper, is level with the bottom of the lot's base. */
const GROUND_Z = BASE_BOTTOM;
/** The lot, flat on the plan before it springs up. */
const FLAT = 0.03;
/** At most this many of the chart's bars on the ground. */
const GROUND_BARS = 400;
const GAP = 72;
const LIFT_CLEAR = 170;
const BAR_SELECTOR = '.b-gantt-task-wrap:not(.b-gantt-task-parent, .b-milestone-wrap)';
const BLOCK_DEPTH = 7;
/**
 * The crane's rental, played day by day for the film (rental-story.ts): how long a day takes by what it is (an idle day
 * long enough to read, a day of work quick enough to see the frame go up), a moment on the first day before it moves,
 * where the site is seen from while it plays, and the camera's moves after: in on the idle days through a long lens, out
 * again as the lens opens (a dolly zoom), and up into a slow circle of the site while the dates change.
 */
const STORY_DAY: Readonly<Record<'idle' | 'cover' | 'work' | 'paid' | 'off', number>> = { idle: 0.36, cover: 0.36, work: 0.24, paid: 0.24, off: 0.2 };
const STORY_HOLD = 0.45;
const STORY_FROM = { azimuth: -0.55, elevation: 0.95 } as const;
const LONG_LENS = 13;
/** The close look at the idle days: from the street side, the way the calendar reads, and steeply, over the site office. */
const IDLE_FROM = { azimuth: 0.04, elevation: 0.55 } as const;
const DOLLY_SECONDS = 3.2;
const RISE_SECONDS = 2.6;
/**
 * The circle while the dates change: round the crane's calendar from the street side through the west to the north,
 * where the building stands behind the calendar and never between, about a fifth of the frame across, slowly.
 */
const CIRCLE_SECONDS = 28;
const CIRCLE_TURN = -2.9;
const CIRCLE_SHARE = 0.12;
/** A little steeper than the fly-around, so the site office never comes between the camera and the calendar. */
const CIRCLE_LEAN = -0.08;
/** The room left under the calendar, held on it for the change of dates, for what the change saved. */
const HOLD_TAG_ROOM = 112;
/** How long new rental dates take to fold the old days away on the calendar while the rental is told. */
const FOLD_SECONDS = 2.6;
type Lens = 'work' | 'firms' | 'money';

export interface BuildingHost {
  /** Puts the canvas over this part of the window, or back over all of it. */
  setInset(rect: { left: number; top: number; width: number; height: number } | null): void;
  lights: StageLights;
}

export interface BuildingView extends SiteView {
  /** Whether the plan, as it is now, is a building this view can show. */
  fits(): boolean;
  /**
   * Builds the building before its first visit and draws every kind of piece once out of sight, so nothing is
   * built or compiled on the way in. Call it while nothing else is going on; it does nothing once there is a model.
   */
  warm(): Promise<void>;
  /** Whether it is on screen (or on its way in or out). */
  isOpen(): boolean;
  render(): boolean;
  quality(level: number): void;
}

/** A bar of the chart as a block in the scene, on its way between the chart and the building. */
interface Block {
  id: number;
  mesh: Mesh;
  face: MeshBasicMaterial;
  side: MeshBasicMaterial;
  /** Where the bar is on screen, from the middle of the view, how big, and its outline and corners, in pixels. */
  onScreen: { x: number; y: number; w: number; h: number; border: number; radius: number };
  /** Where it sits on the chart's sheet, and how big. */
  bar: Vector3;
  size: Vector2;
  /** Where its piece is in the building. */
  piece: Vector3;
  /** When it leaves, as a share of the move, and how long it takes. */
  delay: number;
  span: number;
}

/** The crane's rental, told for the film: where the telling has got to. */
interface Story {
  /** Playing its days, and the moment on the first day before they move on. */
  playing: boolean;
  holdUntil: number;
  /** Which of its days stand out on the calendar, and how far that has come in. */
  emphasis: CalendarEmphasis;
  shown: number;
  /** The close look at the idle days, waiting for the play to reach the last day; who waits for the camera to get there. */
  idleWanted: boolean;
  arrived: (() => void)[];
  /** Out and around the site while the dates change. */
  circling: boolean;
  /** Close on the calendar while the dates change, instead of out and around. */
  holding: boolean;
  /** New dates while it was told, from when what they saved is on screen, and whether it is. */
  change: RentalChange | null;
  changeAt: number;
  changeShown: boolean;
}

interface Move {
  kind: 'dive' | 'return';
  t: number;
  seconds: number;
  from: Pose;
  to: Pose;
  blocks: Block[];
  /** Going back: when each task's pieces leave, as a share of the move. */
  at: Map<number, number>;
  /** Going in: the block of the bar gone through, which the lot grows out of. */
  through: Block | null;
  after?: () => void;
}

const midnight = (at: number) => {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};
const midday = (at: number) => midnight(at) + DAY_MS / 2;
/** The day of an instant, YYYY-MM-DD, where the person is. */
const isoOf = (at: number) => {
  const day = new Date(at);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};
const dateOnly = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
};
const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
/** "Mon, Mar 1", as the app writes a day. */
const SHORT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smoothIn = (t: number) => t * t * t;
/** Out with a little overshoot, settling back: something springing up. */
const backOut = (t: number, give = 1.25) => 1 + (give + 1) * (t - 1) ** 3 + give * (t - 1) ** 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const within = (value: number, from: number, to: number) => Math.min(1, Math.max(0, (value - from) / Math.max(1e-6, to - from)));
const damp = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));
const datesOf = (task: PlanTask) => (task.end - task.start > DAY_MS ? `${SHORT_DATE.format(task.start)} to ${SHORT_DATE.format(task.end - 1)}` : SHORT_DATE.format(task.start));
const isClear = (color: string) => !color || /rgba\(.*, 0\)|transparent/.test(color);

/** The plan's rows as the building reads them, with what the site board knows about each (money, payments, idle days). */
/** Each phase's color, as the stylesheet has it. */
const PHASE_COLORS = new Map<string, string>();

export function readPlanTasks(gantt: Gantt, look: LookState): { tasks: PlanTask[]; sites: Map<number, SiteTask>; records: Map<number, TaskModel> } {
  const project = gantt.project as unknown as { taskStore: { allRecords: TaskModel[] }; resourceStore: { records: ResourceModel[] } };
  const everyRecord = project.taskStore.allRecords.filter((record) => !(record as unknown as { isRoot?: boolean }).isRoot);
  const leaves = everyRecord.filter((record) => record.isLeaf && record.startDate instanceof Date && record.endDate instanceof Date);
  const sites = new Map(siteTasks(leaves.filter((record) => !record.isMilestone), everyRecord, crewNames(project.resourceStore.records), look).map((site) => [site.record.id as number, site]));
  // The chart's colors, read from its own classes, so a piece matches its bar; the stylesheet's, so read once.
  let probe: HTMLDivElement | null = null;
  const colorOf = (task: TaskModel) => {
    const name = phaseClass(task);
    let color = PHASE_COLORS.get(name);
    if (color === undefined) {
      if (!probe) {
        probe = document.createElement('div');
        gantt.element.append(probe);
      }
      probe.className = name;
      color = getComputedStyle(probe).getPropertyValue('--look-phase').trim() || '#5b6570';
      PHASE_COLORS.set(name, color);
    }
    return color;
  };
  const tasks: PlanTask[] = leaves.map((record) => {
    const task = original(record);
    const facts = sites.get(task.id as number)?.facts ?? factsOf(task, look);
    const path: string[] = [];
    const pathIds: number[] = [];
    for (let parent = task.parent as TaskModel | null; parent && !(parent as unknown as { isRoot?: boolean }).isRoot; parent = parent.parent as TaskModel | null) {
      path.unshift(parent.name ?? '');
      pathIds.unshift(parent.id as number);
    }
    const rental = look.decorations.get(task.id as number)?.rental;
    const kind = facts.machines[0];
    return {
      id: task.id as number,
      name: task.name ?? '',
      path,
      pathIds,
      wbs: facts.wbs,
      start: facts.start.getTime(),
      end: facts.end.getTime(),
      workDays: facts.workDays,
      color: colorOf(task),
      crews: facts.crews.map((crew) => ({ name: crew.name, color: crew.color, people: crew.people })),
      machine: rental && kind ? { kind, name: facts.machine ?? 'Machine', booked: [dateOnly(rental.start), dateOnly(rental.end)] as const, rateMinor: look.canViewCosts ? (facts.rig?.rateMinor ?? 0) : 0 } : null,
      percent: facts.percent,
      milestone: Boolean(task.isMilestone),
    };
  });
  (probe as HTMLDivElement | null)?.remove();
  return { tasks, sites, records: new Map(leaves.map((record) => [original(record).id as number, original(record)])) };
}

export function createBuildingView(context: SiteContext, host: BuildingHost): BuildingView {
  const { gantt, look, scene, camera, renderer } = context;
  let model: BuildingModel | null = null;
  let stage: Stage | null = null;
  let plan: BuildingPlan | null = null;
  let tasks: PlanTask[] = [];
  let sites = new Map<number, SiteTask>();
  let records = new Map<number, TaskModel>();
  let shape = '';
  /** On screen, or on its way in or out. */
  let live = false;
  let leaving = false;
  let date = 0;
  let playing = false;
  /** Playing one piece of work's days: where it stops, and how long each day takes. */
  let playUntil: number | null = null;
  let playPace = SECONDS_PER_DAY;
  let lens: Lens = 'work';
  let apart = 0;
  let apartTarget = 0;
  let focus: number | null = null;
  let lift = 0;
  let cutaway = 0;
  let cutawayTarget = 0;
  let selected: Set<number> | null = null;
  let hovered: number | null = null;
  let quality = 0;
  /** A camera move inside the view. */
  let glide: { from: Pose; to: Pose; t: number; seconds: number; after?: () => void; fromFov?: number; toFov?: number } | null = null;
  /**
   * Once around the site from high up, the eagle's view, about the middle of the building held at `middle` in the frame;
   * a touch of the mouse hands the camera back.
   */
  let orbit: { center: Vector3; middle: Spot; lens: Optics; from: Pose; t: number; seconds: number; last: Pose; turn: number; lean: number } | null = null;
  /** Rising to the eagle's view, before going round: a touch or another move cancels the fly-around. */
  let risingToFly = false;
  /** The second beat of the crane's days, waiting its turn; a touch cancels it. */
  let closerTimer = 0;
  /** Going in or out: blocks, the sheet and the drop through a bar. */
  let move: Move | null = null;
  let hiddenNow: ReadonlySet<number> | null = null;
  let keptDate: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let wanted: readonly number[] | null = null;
  let lastIdle = new Map<number, number>();
  let rowListeners: (() => void) | null = null;
  /** The bar this visit came in through, to go back out through it. */
  let cameThrough: number | null = null;
  let picking = false;
  let rowsAt = 0;
  /**
   * The crane's days as a strip of tiles on the lot in front of the building, as a room's track was: every day it is on
   * rent and every day of its work, an idle day in amber with what it costs. New rental dates fold the idle days away.
   */
  let calendar: { taskId: number; track: DayCalendar; days: string; morph: number; hovered: DayTile | null } | null = null;
  /** Up on the crane: how long since it got on, where the camera was, where it rides, and the mast it turns about. */
  let ride: { t: number; from: Pose; to: Pose; mast: Vector3 } | null = null;
  /** The last pose the view placed the camera at, to set off from when a move starts mid-move. */
  let lastPose: Pose | null = null;
  /** The crane's rental, told for the film; null otherwise. */
  let story: Story | null = null;
  /** Out from the idle days: the lens opens from long to the usual as the camera closes in, so they keep their size. */
  let dolly: { t: number; seconds: number; from: Pose; fromFov: number; toFov: number; after: (at: Pose) => void } | null = null;
  const hookPoint = new Vector3();
  const basePoint = new Vector3();
  const ray: RaycasterType = new Raycaster();
  const pointer = new Vector2();
  const bounds = new Box3();
  const point = new Vector3();
  const money = (minor: number) => wholeMoney(minor, look().currency);

  // ---------------------------------------------------------------------------------------
  // The overlay: what is on show, the floors, the date rail, labels, ways out
  // ---------------------------------------------------------------------------------------

  /** The way down, while the camera is falling it. */
  let well: { group: Group; maps: CanvasTexture[]; walls: MeshBasicMaterial; cap: MeshBasicMaterial; geometries: PlaneGeometry[] } | null = null;

  const overlay = document.createElement('div');
  overlay.className = 'fxb';
  overlay.hidden = true;
  overlay.setAttribute('role', 'region');
  overlay.setAttribute('aria-label', 'Site view');

  const readout = document.createElement('div');
  readout.className = 'fxb-readout';
  readout.setAttribute('aria-live', 'polite');
  const readKicker = document.createElement('div');
  readKicker.className = 'fxb-kicker';
  readKicker.textContent = 'Site view';
  const readDate = document.createElement('div');
  readDate.className = 'fxb-date';
  const readWhat = document.createElement('div');
  readWhat.className = 'fxb-what';
  readout.append(readKicker, readDate, readWhat);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'fxb-close';
  closeButton.title = 'Back to the chart (Esc)';
  closeButton.dataset.testid = 'site-view-close';
  closeButton.innerHTML = '<i class="fa fa-xmark" aria-hidden="true"></i><span>Close</span>';
  closeButton.setAttribute('aria-label', 'Close the site view and go back to the chart');
  closeButton.addEventListener('click', () => close());

  const focusChip = document.createElement('button');
  focusChip.type = 'button';
  focusChip.className = 'fxb-chip';
  focusChip.hidden = true;
  focusChip.addEventListener('click', () => {
    setFocus(null);
    glideTo(heroPose());
  });

  const floors = document.createElement('nav');
  floors.className = 'fxb-floors';
  floors.setAttribute('aria-label', 'Floors');
  const floorsTitle = document.createElement('div');
  floorsTitle.className = 'fxb-floors-title';
  floorsTitle.textContent = 'Floors';
  const apartButton = document.createElement('button');
  apartButton.type = 'button';
  apartButton.className = 'fxb-apart';
  apartButton.setAttribute('aria-pressed', 'false');
  apartButton.innerHTML = '<i class="fa fa-layer-group" aria-hidden="true"></i><span>Take apart</span>';
  apartButton.addEventListener('click', () => setApart(apartTarget > 0.5 ? 0 : 1));
  const floorList = document.createElement('ol');
  floors.append(floorsTitle, floorList, apartButton);
  floors.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'fxb-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Date and colors');
  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'fxb-play';
  playButton.setAttribute('aria-label', 'Play the plan');
  playButton.title = 'Play the plan (Space)';
  playButton.addEventListener('click', () => togglePlay());
  const rail = document.createElement('div');
  rail.className = 'fxb-rail';
  rail.setAttribute('role', 'slider');
  rail.tabIndex = 0;
  rail.setAttribute('aria-label', 'Date on show');
  const railTrack = document.createElement('div');
  railTrack.className = 'fxb-track';
  const railHead = document.createElement('div');
  railHead.className = 'fxb-head';
  const railTip = document.createElement('div');
  railTip.className = 'fxb-tip';
  railHead.append(railTip);
  const railMonths = document.createElement('div');
  railMonths.className = 'fxb-months';
  rail.append(railTrack, railMonths, railHead);
  const lensGroup = document.createElement('div');
  lensGroup.className = 'fxb-lens';
  lensGroup.setAttribute('role', 'radiogroup');
  lensGroup.setAttribute('aria-label', 'Color the pieces by');
  const lensButtons = (
    [
      ['work', 'As built', 'Each piece in its own material'],
      ['firms', 'By firm', 'Each piece in the color of the firm doing it'],
      ['money', 'Payments', 'Paid with PayPal, or not paid yet'],
    ] as const
  ).map(([id, label, hint]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = hint;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', () => setLens(id));
    lensGroup.append(button);
    return { id, button };
  });
  const homeButton = document.createElement('button');
  homeButton.type = 'button';
  homeButton.className = 'fxb-icon';
  homeButton.title = 'The whole site, as it was framed at first';
  homeButton.setAttribute('aria-label', 'Show the whole site');
  homeButton.innerHTML = '<i class="fa fa-house" aria-hidden="true"></i>';
  homeButton.addEventListener('click', () => {
    clearSelection();
    setFocus(null);
    glideTo(heroPose());
  });
  const daysButton = document.createElement('button');
  daysButton.type = 'button';
  daysButton.className = 'fxb-icon';
  daysButton.dataset.testid = 'site-view-rental-days';
  daysButton.title = 'Show the tower crane’s days on rent';
  daysButton.setAttribute('aria-label', 'Show the tower crane’s days on rent');
  daysButton.innerHTML = '<i class="fa fa-calendar-days" aria-hidden="true"></i>';
  daysButton.hidden = true;
  daysButton.addEventListener('click', () => {
    stopPlaying();
    lookAtCalendar();
  });
  const rideButton = document.createElement('button');
  rideButton.type = 'button';
  rideButton.className = 'fxb-icon';
  rideButton.dataset.testid = 'site-view-ride';
  rideButton.title = 'See it from up on the crane';
  rideButton.setAttribute('aria-label', 'See the site from up on the tower crane');
  rideButton.setAttribute('aria-pressed', 'false');
  rideButton.innerHTML = '<i class="fa fa-video" aria-hidden="true"></i>';
  rideButton.hidden = true;
  rideButton.addEventListener('click', () => rideCrane(!ride));
  const flyButton = document.createElement('button');
  flyButton.type = 'button';
  flyButton.className = 'fxb-icon is-word';
  flyButton.dataset.testid = 'site-view-fly';
  flyButton.title = 'Fly all the way around the site, from the air';
  flyButton.setAttribute('aria-label', 'Fly 360 degrees around the site, from the air');
  flyButton.setAttribute('aria-pressed', 'false');
  flyButton.textContent = '360°';
  flyButton.addEventListener('click', () => (orbit || risingToFly ? stopOrbit() : flyAround()));
  const floorsButton = document.createElement('button');
  floorsButton.type = 'button';
  floorsButton.className = 'fxb-icon';
  floorsButton.dataset.testid = 'site-view-floors';
  floorsButton.title = 'Floors';
  floorsButton.setAttribute('aria-label', 'Show the floors');
  floorsButton.setAttribute('aria-pressed', 'false');
  floorsButton.innerHTML = '<i class="fa fa-layer-group" aria-hidden="true"></i>';
  floorsButton.addEventListener('click', () => {
    floors.hidden = !floors.hidden;
    floorsButton.setAttribute('aria-pressed', String(!floors.hidden));
  });
  bar.append(playButton, rail, lensGroup, floorsButton, daysButton, rideButton, flyButton, homeButton);

  /**
   * The controls stay out of the way: they show while the pointer moves over the scene or one of them has the
   * focus, and fade a moment after it rests. They sit above the call and its captions, and left of the side panel
   * when it is over the scene, measured as they are (`makeRoom`).
   */
  let idleTimer = 0;
  function wakeControls(): void {
    overlay.classList.remove('is-idle');
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (!bar.matches(':hover, :focus-within')) overlay.classList.add('is-idle');
    }, 2600);
  }
  renderer.domElement.addEventListener('pointermove', wakeControls);
  overlay.addEventListener('pointermove', wakeControls);
  overlay.addEventListener('focusin', wakeControls);
  /** How much of the window's right side the side panel over the scene takes, with its margin; 0 while it is closed. */
  const panelSpace = (): number => (context.panel.isOpen() ? Math.round(context.panel.width() + 24) : 0);
  let roomMeasuredAt = 0;
  /**
   * The room the controls have: above the call and its captions, and left of the side panel, the same room the ride
   * and the fly-around frame their shots in (`openRoom`). Too narrow for one row, they take two: the dates, then the
   * buttons.
   */
  function makeRoom(now: number, force = false): void {
    if (!force && now - roomMeasuredAt < 300) return;
    roomMeasuredAt = now;
    let top = window.innerHeight;
    for (const element of document.querySelectorAll<HTMLElement>('[data-testid="rail-call"]')) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) top = Math.min(top, rect.top);
    }
    overlay.style.setProperty('--fxb-call-space', `${Math.max(0, Math.round(window.innerHeight - top))}px`);
    callTop = top;
    const side = panelSpace();
    overlay.style.setProperty('--fxb-panel-space', `${side}px`);
    overlay.classList.toggle('is-tight', context.size().width - side < 760);
  }

  /** How to move around in it, said once the view is up; gone at the first touch. */
  const hint = document.createElement('div');
  hint.className = 'fxb-hint';
  hint.hidden = true;
  hint.innerHTML = '<span><b>Drag</b> to turn</span><span><b>Scroll</b> or <b>pinch</b> to zoom</span><span><b>Shift-drag</b> to move</span>';
  let hintTimer = 0;
  function showHint(): void {
    // Nothing tells people how to move: the controls show as soon as they do.
    if (live) return;
    hint.hidden = false;
    hint.classList.add('is-shown');
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(hideHint, 7000);
  }
  function hideHint(): void {
    window.clearTimeout(hintTimer);
    hint.classList.remove('is-shown');
    hintTimer = window.setTimeout(() => (hint.hidden = true), 400);
  }
  // A touch of the mouse or the wheel ends a fly-around (the camera stays where it is) and the hint, before the
  // controls see the same press, so the drag that stopped it already turns the view.
  const takeOver = () => {
    if (!live) return;
    window.clearTimeout(closerTimer);
    if (orbit || risingToFly) stopOrbit();
    // On the way out from the crane's idle days, the camera stays where it had got to.
    if (dolly && lastPose) {
      dolly = null;
      context.handToControls(lastPose, undefined, lastPose.distance * 1.6);
    }
    if (story) story.circling = false;
    if (!hint.hidden) hideHint();
  };
  renderer.domElement.addEventListener('pointerdown', takeOver, { capture: true });
  renderer.domElement.addEventListener('wheel', takeOver, { capture: true, passive: true });

  const legend = document.createElement('div');
  legend.className = 'fxb-legend';
  legend.hidden = true;

  const labels = document.createElement('div');
  labels.className = 'fxb-labels';
  const callout = document.createElement('div');
  callout.className = 'fxb-callout';
  callout.hidden = true;
  const machineTag = document.createElement('button');
  machineTag.type = 'button';
  machineTag.className = 'fxb-machine';
  machineTag.hidden = true;
  machineTag.title = 'See the days it is on rent';
  machineTag.addEventListener('click', () => lookAtCalendar());
  const hoverTip = document.createElement('div');
  hoverTip.className = 'fxb-hovertip';
  hoverTip.hidden = true;
  const layerTags = document.createElement('div');
  layerTags.className = 'fxb-layer-tags';
  const calendarTag = document.createElement('button');
  calendarTag.type = 'button';
  calendarTag.className = 'fxb-calendar-tag';
  calendarTag.hidden = true;
  calendarTag.title = 'Look at the days it is on rent';
  calendarTag.addEventListener('click', () => lookAtCalendar());
  // Its lines are kept and written in place, so the strip of days in it can move from one set of dates to the next.
  const tagTitle = document.createElement('strong');
  const tagWords = document.createElement('span');
  /**
   * While the rental is told: its days on rent as a strip, a cell a day by the calendar's rule (idle in amber), the date
   * on show marked; new dates fold the cells that go away and turn those that change, in the calendar's order and time.
   */
  const dayStrip = document.createElement('div');
  dayStrip.className = 'fxb-day-strip';
  dayStrip.setAttribute('aria-hidden', 'true');
  dayStrip.hidden = true;
  const tagSaving = document.createElement('b');
  tagSaving.className = 'fxb-saving';
  tagSaving.hidden = true;
  calendarTag.append(tagTitle, tagWords, dayStrip, tagSaving);
  /** The work under way on the date, named where it is, as the site board names its plots. */
  const nowTags = document.createElement('div');
  nowTags.className = 'fxb-now-tags';
  const toast = document.createElement('div');
  toast.className = 'fxb-toast';
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  /** The bar's own color, filling the view as the camera drops through it. */
  /** A story a payment gate holds: what it waits for, and the way to the payment (gantt/pay-gates.ts). */
  const holdTags = document.createElement('div');
  holdTags.className = 'fxb-hold-tags';
  /** Over the crane while its rental plays: IDLE, on a day it is on rent with nothing to lift. */
  const idleTag = document.createElement('div');
  idleTag.className = 'fxb-idle-tag';
  idleTag.hidden = true;
  idleTag.innerHTML = '<b>Idle</b><span>Nothing to lift</span>';
  labels.append(nowTags, layerTags, holdTags, calendarTag, idleTag, machineTag, hoverTip, callout);
  overlay.append(labels, readout, closeButton, focusChip, floors, legend, hint, bar, toast);
  document.body.append(overlay);

  // ---------------------------------------------------------------------------------------
  // Where the view goes: the chart's side of the Gantt
  // ---------------------------------------------------------------------------------------

  /** The whole window under the app's header, which keeps the project's name and the walkthrough's steps. */
  function insetRect(): { left: number; top: number; width: number; height: number } {
    const header = document.querySelector<HTMLElement>('.app-header');
    const top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    return { left: 0, top, width: Math.max(200, window.innerWidth), height: Math.max(200, window.innerHeight - top) };
  }

  let placedWidth = 0;
  /** Where the view begins on the page, and where the call bar over its bottom begins (page pixels). */
  let viewTop = 0;
  let callTop = Infinity;
  function place(known?: { left: number; top: number; width: number; height: number }): void {
    const rect = known ?? insetRect();
    viewTop = rect.top;
    document.documentElement.style.setProperty('--fxb-top', `${rect.top}px`);
    host.setInset(rect);
    Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    overlay.classList.toggle('is-narrow', rect.width < 760);
    stage?.setSize(rect.width, rect.height, renderer.getPixelRatio());
    // A side panel opening or closing changes the view's shape a lot: what is on show is framed again for it.
    const changed = placedWidth > 0 && Math.abs(rect.width - placedWidth) / placedWidth > 0.15;
    placedWidth = rect.width;
    if (changed && live && !leaving && !move) reframe();
  }

  function reframe(): void {
    const pose = selected ? posePiece([...selected]) : focus !== null ? storyPose(focus) : heroPose();
    if (pose) glideTo(pose, 0.8);
  }

  // ---------------------------------------------------------------------------------------
  // Reading the plan, building the model
  // ---------------------------------------------------------------------------------------

  function read(): BuildingPlan | null {
    const read = readPlanTasks(gantt, look());
    tasks = read.tasks;
    sites = read.sites;
    records = read.records;
    return readBuilding(tasks);
  }

  function shapeOf(list: readonly PlanTask[], withRentals = true): string {
    return list.map((task) => `${task.id}:${task.name}:${task.start}:${task.end}:${task.machine && withRentals ? task.machine.booked.join('-') : ''}:${task.crews.map((crew) => crew.color).join()}`).join('|');
  }

  /** The plan as it is now, when only machines' dates changed: the model takes their new dates, nothing is rebuilt. */
  function rebook(next: BuildingPlan): void {
    if (!model) return;
    for (const booking of next.bookings) {
      const held = model.plan.bookings.find((entry) => entry.task.id === booking.task.id && entry.machine.kind === booking.machine.kind);
      if (held) held.machine.booked = booking.machine.booked;
    }
    plan = next;
    paint();
    writeFloors();
    writeRail();
    placeCalendar();
  }

  /** The model kept from before, on show again for the plan as it is now. */
  function showAgain(next: BuildingPlan): void {
    if (!model) return;
    plan = next;
    model.root.visible = true;
    model.setOffsets(offsets());
    model.setCutaway(cutaway);
    model.setDate(date);
    paint();
    writeFloors();
    writeRail();
    placeCalendar();
  }

  function build(next: BuildingPlan): void {
    model?.dispose();
    plan = next;
    model = createBuilding(next, { workers: context.workers(), props: context.props() });
    scene.add(model.root);
    model.setOffsets(offsets());
    model.setCutaway(cutaway);
    model.setDate(date);
    paint();
    writeFloors();
    writeRail();
    placeCalendar();
  }

  /**
   * The crane's calendar lies in the yard north of the site office, between the toilets and the dig, short of the
   * crane's base: the crane stands right behind it.
   */
  const CALENDAR_AT = { x: -222, y: -20 } as const;

  /** The crane's strip of days: made once, and given new days (folding the old idle ones away) when its rental moves. */
  function placeCalendar(): void {
    const booking = plan?.bookings.find((entry) => entry.machine.kind === 'crane');
    const site = booking ? sites.get(booking.task.id) : undefined;
    if (!booking || !site || site.days.length === 0) {
      dropCalendar();
      return;
    }
    const key = site.days.map((day) => `${day.at}:${day.kind}`).join('|');
    if (calendar && calendar.taskId === booking.task.id) {
      if (calendar.days !== key) {
        calendar.track.setDays(site.days);
        calendar.days = key;
        calendar.morph = 0;
      }
      return;
    }
    dropCalendar();
    const colors = { bar: booking.task.color, idle: tokenColor('--warning-fill') || '#f3c46b', ink: tokenColor('--ink') || '#1f2428', soft: tokenColor('--ink-soft') || '#5b646c', paper: tokenColor('--surface') || '#ffffff', off: tokenColor('--gray-300') || '#cfd3d6' };
    // As large as that patch of the yard allows.
    const track = createDayCalendar(site.days, colors, money, { room: 58, largest: 16, ring: tokenColor('--warning') || '#a8670a' });
    track.group.position.set(CALENDAR_AT.x, CALENDAR_AT.y, 0.4);
    track.group.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh) mesh.receiveShadow = true;
    });
    scene.add(track.group);
    track.update(date);
    calendar = { taskId: booking.task.id, track, days: key, morph: 1, hovered: null };
    daysButton.hidden = false;
    rideButton.hidden = false;
  }

  function dropCalendar(): void {
    if (!calendar) return;
    calendar.track.group.removeFromParent();
    calendar.track.group.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material as MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    });
    calendar = null;
    calendarTag.hidden = true;
    daysButton.hidden = true;
    rideButton.hidden = true;
  }

  /** The strip shows while the crane is about: a week either side of its rental, or while its work is chosen. */
  function calendarShown(): boolean {
    if (!calendar || !plan || move) return false;
    if (story?.holding) return true;
    const booking = plan.bookings.find((entry) => entry.task.id === calendar!.taskId);
    if (!booking) return false;
    if (selected?.has(calendar.taskId)) return true;
    const [from, to] = booking.machine.booked;
    return date >= from - 7 * DAY_MS && date < to + 7 * DAY_MS && focus === null && apart < 0.3;
  }

  /**
   * The crane's days: the whole crane, the calendar of its days on the ground in front of it, and the building it works
   * on, from high over the street side. Nothing is cut: the crane stands up to its jib.
   */
  function lookAtCalendar(azimuth = 0.22, elevation = 1.0): void {
    if (!calendar || !model) return;
    const booking = plan?.bookings.find((entry) => entry.task.id === calendar!.taskId);
    if (booking && !calendarShown()) setDate(midday(booking.machine.booked[0]));
    calendar.track.group.updateWorldMatrix(true, true);
    attendBox(new Box3().setFromObject(calendar.track.group));
    const points = cornersOf(new Box3().setFromObject(calendar.track.group));
    // The crane's mast, foot to cab, stands up behind the calendar; its jib reaches on over the building.
    const crane = model.craneBounds(new Box3());
    if (crane) {
      for (const [dx, dy] of [
        [-14, -14],
        [14, 14],
      ] as const) {
        points.push(new Vector3(CRANE_AT.x + dx, CRANE_AT.y + dy, 0), new Vector3(CRANE_AT.x + dx, CRANE_AT.y + dy, crane.max.z));
      }
    }
    // First the whole crane, the calendar at its foot; then down to the calendar, near enough to read its days, the
    // mast rising behind it. A touch or another move on the way keeps the camera where it is.
    // Elevation is the camera's angle from straight down (rig.ts).
    const whole = fitPoints(points, azimuth, elevation, { pad: 0.04 });
    const days = fitPoints(cornersOf(new Box3().setFromObject(calendar.track.group)), 0.08, 0.72, { pad: 0.1 });
    window.clearTimeout(closerTimer);
    glideTo(whole, MOVE_SECONDS * 1.2, () => {
      closerTimer = window.setTimeout(() => {
        if (live && !move && !glide && !orbit && !ride && calendarShown()) glideTo(days, MOVE_SECONDS * 1.5);
      }, 1500);
    });
  }


  /**
   * The room the scene has: the canvas less the floors on the right (unless they are away), the readout and the bar;
   * with `withPanel`, less the side panel over the scene too (the task, Remy, the watch list), which hides what is
   * behind it.
   */
  function openRoom(withFloors = true, withPanel = false): { width: number; height: number; side: number; top: number; bottom: number } {
    const { width, height } = context.size();
    const canvasTop = renderer.domElement.getBoundingClientRect().top;
    const floorsSide = withFloors && floors.getClientRects().length > 0 ? floors.getBoundingClientRect().width + 24 : 0;
    const panelSide = withPanel ? panelSpace() : 0;
    const top = readout.getClientRects().length > 0 ? readout.getBoundingClientRect().bottom - canvasTop + 8 : 0;
    const bottom = bar.getClientRects().length > 0 ? height - (bar.getBoundingClientRect().top - canvasTop) + 8 : 0;
    return { width, height, side: Math.max(floorsSide, panelSide), top: Math.max(0, top), bottom: Math.max(0, bottom) };
  }

  /** The room in the frame's own terms, -1 to 1 across and up: its edges, its middle, and the lens that sees it. */
  function roomFrame(room: ReturnType<typeof openRoom>): { left: number; right: number; top: number; bottom: number; middle: Spot; lens: Optics } {
    const left = -1 + (2 * 12) / room.width;
    const right = 1 - (2 * (room.side + 12)) / room.width;
    const top = 1 - (2 * room.top) / room.height;
    const bottom = -1 + (2 * room.bottom) / room.height;
    return { left, right, top, bottom, middle: { x: (left + right) / 2, y: (top + bottom) / 2 }, lens: { fov: FOV, aspect: room.width / Math.max(1, room.height) } };
  }

  const cornersOf = (box: Box3): Vector3[] =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((corner) => new Vector3(corner & 1 ? box.max.x : box.min.x, corner & 2 ? box.max.y : box.min.y, corner & 4 ? box.max.z : box.min.z));

  const probe = new PerspectiveCamera();
  const seen = new Vector3();
  const probeRight = new Vector3();
  const probeUp = new Vector3();

  /** The probe made like the camera, for a canvas of this shape. */
  function shapeProbe(lens: Optics): void {
    probe.fov = lens.fov;
    probe.aspect = lens.aspect;
    probe.near = 1;
    probe.far = 1e6;
    probe.updateProjectionMatrix();
  }

  /**
   * The closest pose, from this side and this height, that shows every one of `points` inside the room the overlay
   * leaves, with what they cover in the middle of that room. Measured by projecting them, as the camera will.
   */
  function fitPoints(points: readonly Vector3[], azimuth: number, elevation: number, { pad = 0.06, withFloors = true, withPanel = false, fov, below }: { pad?: number; withFloors?: boolean; withPanel?: boolean; fov?: number; below?: number } = {}): Pose {
    const room = openRoom(withFloors, withPanel);
    // `below` is the room to leave under what is framed, in place of what the view's own controls would take.
    const { left, right, top, bottom, lens } = roomFrame(below === undefined ? room : { ...room, bottom: below });
    shapeProbe(fov ? { ...lens, fov } : lens);
    const target = new Box3().setFromPoints(points as Vector3[]).getCenter(new Vector3());
    const extent = (distance: number) => {
      placeCamera(probe, { x: target.x, y: target.y, z: target.z, azimuth, elevation, distance });
      let [minX, maxX, minY, maxY, behind] = [Infinity, -Infinity, Infinity, -Infinity, false];
      for (const at of points) {
        seen.copy(at).project(probe);
        if (seen.z > 1 || seen.z < -1) behind = true;
        minX = Math.min(minX, seen.x);
        maxX = Math.max(maxX, seen.x);
        minY = Math.min(minY, seen.y);
        maxY = Math.max(maxY, seen.y);
      }
      return { minX, maxX, minY, maxY, behind };
    };
    let distance = 1000;
    for (let pass = 0; pass < 3; pass++) {
      let [near, far] = [40, 40_000];
      for (let step = 0; step < 36; step++) {
        const mid = (near + far) / 2;
        const span = extent(mid);
        const fits = !span.behind && span.maxX - span.minX <= (right - left) * (1 - pad) && span.maxY - span.minY <= (top - bottom) * (1 - pad);
        if (fits) far = mid;
        else near = mid;
      }
      distance = far;
      // Then what they cover is moved to the middle of the room, along the camera's own right and up.
      const span = extent(distance);
      const halfTan = Math.tan((probe.fov * Math.PI) / 360);
      probeRight.setFromMatrixColumn(probe.matrixWorld, 0);
      probeUp.setFromMatrixColumn(probe.matrixWorld, 1);
      target.addScaledVector(probeRight, ((span.minX + span.maxX) / 2 - (left + right) / 2) * distance * halfTan * probe.aspect);
      target.addScaledVector(probeUp, ((span.minY + span.maxY) / 2 - (top + bottom) / 2) * distance * halfTan);
    }
    return { x: target.x, y: target.y, z: target.z, azimuth, elevation, distance };
  }

  /** The whole site, as it will stand, with the crane while it is up: nothing of either cut. */
  function sitePoints(): Vector3[] {
    return model ? cornersOf(model.siteBounds(new Box3())) : [];
  }

  /**
   * The eagle's view for going once around: the middle of the building as it will stand held at the middle of the room
   * (what the side panel covers left out) all the way round, high enough that the neighbors never come between, and as
   * far back as the farthest-reaching side needs to keep the lot, the building and the crane in the frame.
   */
  function overview(azimuth: number, with_: Box3 | null = null): { pose: Pose; center: Vector3; middle: Spot; lens: Optics } | null {
    if (!model) return null;
    const building = model.siteBounds(new Box3(), false);
    // Something to keep in the frame as well (the crane's calendar on the lot): the circle turns about the middle of both.
    const center = (with_ ? building.clone().union(with_) : building).getCenter(new Vector3());
    const points = [...cornersOf(building), ...[LOT.x0, LOT.x1].flatMap((x) => [LOT.y0, LOT.y1].map((y) => new Vector3(x, y, 0))), ...(with_ ? cornersOf(with_) : [])];
    const crane = model.craneBounds(new Box3());
    if (crane) points.push(...cornersOf(crane));
    const { left, right, top, bottom, middle, lens } = roomFrame(openRoom(false, true));
    shapeProbe(lens);
    const fits = (pose: Pose) => {
      placeCamera(probe, pose);
      for (const at of points) {
        seen.copy(at).project(probe);
        if (seen.z > 1 || seen.z < -1 || seen.x < left || seen.x > right || seen.y < bottom || seen.y > top) return false;
      }
      return true;
    };
    let distance = 0;
    for (let turn = 0; turn < 12; turn++) {
      let [near, far] = [40, 40_000];
      for (let step = 0; step < 30; step++) {
        const mid = (near + far) / 2;
        const around = azimuth + (turn * Math.PI) / 6;
        if (fits(aroundPose(center, around, flyLean(around), mid, middle, lens))) far = mid;
        else near = mid;
      }
      distance = Math.max(distance, far * 1.04);
    }
    return { pose: aroundPose(center, azimuth, flyLean(azimuth), distance, middle, lens), center, middle, lens };
  }

  /** Up to the eagle's view, then once around the site, slowly. The camera is the person's again after, or at a touch. */
  function flyAround(): void {
    if (!live || move || !model) return;
    clearSelection();
    deselectRows();
    if (focus !== null) setFocus(null);
    if (!hint.hidden) hideHint();
    const from = orbit || risingToFly ? stopOrbit() : context.takeFromControls();
    const way = overview(from.azimuth);
    if (!way) return;
    glideTo(way.pose, MOVE_SECONDS, () => {
      risingToFly = false;
      if (!live || move) return;
      context.takeFromControls();
      orbit = { center: way.center, middle: way.middle, lens: way.lens, from: way.pose, t: 0, seconds: context.reducedMotion ? 0.01 : FLY_SECONDS, last: way.pose, turn: Math.PI * 2, lean: 0 };
      context.wake();
    });
    flyLook(true);
    risingToFly = true;
  }

  /** The floors step aside while it flies, so the whole width is the site's; the button is lit. */
  function flyLook(on: boolean): void {
    overlay.classList.toggle('is-flying', on);
    flyButton.classList.toggle('is-on', on);
    flyButton.setAttribute('aria-pressed', String(on));
  }

  /** Where the crane hangs its hook while someone rides it: over the middle of the work, a little over what stands there. */
  function rideHold(): { x: number; y: number; hookZ: number } {
    return { x: (FOOTPRINT.x0 + FOOTPRINT.x1) / 2, y: (FOOTPRINT.y0 + FOOTPRINT.y1) / 2, hookZ: Math.max(150, (model?.builtTop() ?? 0) + 45) };
  }

  /**
   * The ride on the crane (rig.ts `onTheJib`): out past the tip of its jib, looking back along it and down at the lot,
   * the hook hanging over the work and the mast standing up at the far end with its days on rent at its foot, in the
   * middle of the room the scene has. It faces the way the crane swings to when it has nothing to lift (`rideHold`), so
   * it never looks out at the neighbors whichever way the wind left the jib; a working crane lifts in front of it.
   */
  function rideTo(): Pose | null {
    const jib = model?.craneJib();
    if (!model || !jib) return null;
    const over = rideHold();
    const { eye, look } = onTheJib(model.craneBase(basePoint), Math.atan2(over.y - CRANE_AT.y, over.x - CRANE_AT.x), jib);
    const { middle, lens } = roomFrame(openRoom(true, true));
    return aimFrom(eye, look, middle, lens);
  }

  /** Up onto the crane while it is up, and back down to what was being looked at. */
  function rideCrane(on: boolean): void {
    if (!live || !model || move) return;
    if (on) {
      if (ride) return;
      if (!model.craneHook(hookPoint)) {
        // Not on site on the day on show: up on its first idle day, or its first day on rent.
        const booking = plan?.bookings.find((entry) => entry.machine.kind === 'crane');
        if (!booking) return;
        const [from, to] = booking.machine.booked;
        let day = from;
        while (day < to && day >= booking.task.start && day < booking.task.end) day += DAY_MS;
        setDate(midday(day < to ? day : from));
      }
      const to = rideTo();
      if (!to) return;
      stopPlaying();
      if (orbit || risingToFly) stopOrbit();
      window.clearTimeout(closerTimer);
      const from = glide ? (lastPose ?? heroPose()) : context.takeFromControls();
      glide = null;
      // The shorter way round, from wherever the camera was.
      while (to.azimuth - from.azimuth > Math.PI) to.azimuth -= Math.PI * 2;
      while (to.azimuth - from.azimuth < -Math.PI) to.azimuth += Math.PI * 2;
      ride = { t: 0, from, to, mast: model.craneBase(new Vector3()) };
      // With nothing to lift, the crane swings round under the camera to hang its hook over the work.
      model.holdCrane(rideHold());
      syncRide();
      // Nothing over the view from up here: the card comes back with the camera.
      callout.hidden = true;
      hoverTip.hidden = true;
      context.companion.attend(null);
      hideHint();
      context.wake();
      return;
    }
    if (!ride) return;
    const from = lastPose ?? ride.to;
    endRide();
    if (selected) {
      writeCallout();
      attendBox(boxOf(selected));
    }
    glide = { from, to: selected ? (posePiece([...selected]) ?? heroPose()) : focus !== null ? storyPose(focus) : heroPose(), t: 0, seconds: context.reducedMotion ? 0.01 : MOVE_SECONDS };
    context.wake();
  }

  /** Off the crane, which is let go to drift with the wind again. */
  function endRide(): void {
    ride = null;
    model?.holdCrane(null);
    syncRide();
  }

  function syncRide(): void {
    rideButton.classList.toggle('is-on', Boolean(ride));
    rideButton.setAttribute('aria-pressed', String(Boolean(ride)));
  }

  /** Ends a fly-around where it is (or on its way up), and hands the camera back there. */
  function stopOrbit(): Pose {
    let at: Pose;
    if (orbit) at = orbit.last;
    else if (risingToFly && glide) at = mixPose(glide.from, glide.to, ease(glide.t));
    else at = context.takeFromControls();
    orbit = null;
    if (risingToFly) glide = null;
    risingToFly = false;
    flyLook(false);
    context.handToControls(at, undefined, at.distance * 1.6);
    return at;
  }

  // ---------------------------------------------------------------------------------------
  // The camera
  // ---------------------------------------------------------------------------------------

  function heroPose(): Pose {
    const spread = Math.max(apart, apartTarget);
    // Together, the whole site fits the room: the building as it will stand, and the crane up to its jib while it's up.
    if (model && spread < 0.05) return fitPoints(sitePoints(), -0.66, 1.04);
    const { width, height } = context.size();
    const wide = width / Math.max(1, height);
    return { x: -12, y: -18, z: 104 + spread * 150, azimuth: -0.66, elevation: 1.08 - spread * 0.08, distance: (wide < 1.2 ? 1080 : 940) + spread * 520 };
  }

  /** Close on one story, from the open corner. */
  function storyPose(layer: number): Pose {
    if (!model) return heroPose();
    const center = model.layerCenter(layer, point);
    const settled = model.layerSpan(layer).z + model.layerSpan(layer).height / 2 + Math.max(apart, apartTarget) * GAP * layer;
    const { width, height } = context.size();
    const wide = width / Math.max(1, height);
    return { x: center.x + 6, y: center.y - 6, z: settled - 6, azimuth: -0.6, elevation: layer === FOUNDATIONS ? 0.95 : 1.2, distance: wide < 1.2 ? 980 : 860 };
  }

  function boxOf(ids: Iterable<number>): Box3 | null {
    if (!model) return null;
    const box = new Box3();
    for (const id of ids) {
      const part = model.boundsOf(id, bounds);
      if (part) box.union(part);
    }
    return box.isEmpty() ? null : box;
  }

  function posePiece(ids: readonly number[]): Pose | null {
    const box = boxOf(ids);
    if (!box) return null;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const reach = Math.max(size.x, size.y * 1.2, size.z * 1.6, 90);
    return { x: center.x, y: center.y, z: center.z, azimuth: -0.66, elevation: 1.12, distance: Math.min(1500, Math.max(380, reach * 2.2)) };
  }

  function glideTo(to: Pose, seconds = MOVE_SECONDS, after?: () => void, fov = FOV): void {
    if (move) return;
    // Going somewhere ends a fly-around, from where it had got to, and a ride on the crane, from up there.
    const riding = ride ? (lastPose ?? ride.to) : null;
    if (ride) endRide();
    // Mid-move, from where the move had got to: the controls are off while one runs, so they don't know.
    const moving = (glide || dolly) && lastPose ? lastPose : null;
    dolly = null;
    const from = riding ?? (orbit || risingToFly ? stopOrbit() : (moving ?? context.takeFromControls()));
    context.takeFromControls();
    // The shorter way round.
    let azimuth = to.azimuth;
    while (azimuth - from.azimuth > Math.PI) azimuth -= Math.PI * 2;
    while (azimuth - from.azimuth < -Math.PI) azimuth += Math.PI * 2;
    glide = { from, to: { ...to, azimuth }, t: 0, seconds: context.reducedMotion ? 0.01 : seconds, fromFov: camera.fov, toFov: fov, ...(after ? { after } : {}) };
    context.wake();
  }

  /** The camera square over the chart's side, so a block on the sheet covers its bar exactly. */
  /** Straight down over the ground, where the plan's bars lie exactly over the chart's bars on the page. */
  function restNow(): Pose {
    const { width, height } = context.size();
    const middle = onGround(width / 2, height / 2);
    return { x: middle.x, y: middle.y, z: GROUND_Z, azimuth: 0, elevation: 0, distance: restDistance(height) * GROUND_SCALE };
  }

  // ---------------------------------------------------------------------------------------
  // The date
  // ---------------------------------------------------------------------------------------

  function setDate(next: number): void {
    if (!plan) return;
    const [start, end] = plan.span;
    date = Math.min(end, Math.max(start, next));
    model?.setDate(date);
    // Ridden, the hook stays a little over what stands on the new date.
    if (ride) model?.holdCrane(rideHold());
    writeReadout();
    writeRailHead();
    writeFloorStates();
    rowsAt = 0;
    context.wake();
  }

  function togglePlay(): void {
    if (!plan || move) return;
    playUntil = null;
    playPace = SECONDS_PER_DAY;
    playing = !playing;
    if (playing && date >= plan.span[1] - DAY_MS) setDate(plan.span[0]);
    playButton.classList.toggle('is-playing', playing);
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play the plan');
    context.wake();
  }

  /** One piece of work's days, from its first to the end of its last, played in a couple of seconds. */
  function playDays(from: number, to: number): void {
    if (!plan || move) return;
    const days = Math.max(1, Math.round((to - from) / DAY_MS));
    playPace = Math.min(0.9, Math.max(SECONDS_PER_DAY, 2.6 / days));
    playUntil = to;
    setDate(from);
    playing = true;
    playButton.classList.add('is-playing');
    playButton.setAttribute('aria-label', 'Pause');
    context.wake();
  }

  function stopPlaying(): void {
    playUntil = null;
    playPace = SECONDS_PER_DAY;
    if (!playing) return;
    playing = false;
    playButton.classList.remove('is-playing');
    playButton.setAttribute('aria-label', 'Play the plan');
  }

  // ---------------------------------------------------------------------------------------
  // The crane's rental, day by day: played on the lot, and told in time with Remy (rental-story.ts)
  // ---------------------------------------------------------------------------------------

  const halfTan = (fov: number) => Math.tan((fov * Math.PI) / 360);

  /** The camera's lens, in degrees of height: the usual one (rig.ts), or a long one for a close look from farther off. */
  function setFov(fov: number): void {
    if (Math.abs(camera.fov - fov) < 1e-4) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  /** The crane's booking, and its days on rent as the plan has them now. */
  function craneRental(): { booking: Booking; site: SiteTask; days: RentalDay[] } | null {
    const booking = plan?.bookings.find((entry) => entry.machine.kind === 'crane');
    const site = booking ? sites.get(booking.task.id) : undefined;
    if (!booking || !site) return null;
    const days = daysOnRent(site.days);
    return days.length > 0 ? { booking, site, days } : null;
  }

  function rentalFacts(): RentalFacts | null {
    if (!live || leaving || move || !calendar) return null;
    const rental = craneRental();
    if (!rental) return null;
    const rateMinor = rental.booking.machine.rateMinor;
    const summary = rentalSummary(rental.site.days, rateMinor);
    return summary ? { machine: rental.booking.machine.name, taskId: rental.booking.task.id, summary, rateMinor } : null;
  }

  /** How long the day on show takes in the play. */
  function storyPace(): number {
    const rental = craneRental();
    return STORY_DAY[(rental ? rentalMoment(rental.days, date).day?.kind : null) ?? 'off'];
  }

  function calendarBox(): Box3 | null {
    if (!calendar) return null;
    calendar.track.group.updateWorldMatrix(true, true);
    return new Box3().setFromObject(calendar.track.group);
  }

  /** A box over the calendar's squares of these kinds, in the scene. */
  function squaresBox(kinds: readonly DayKind[]): Box3 | null {
    const squares = calendar?.track.squaresOf(kinds);
    if (!calendar || !squares) return null;
    const at = calendar.track.group.position;
    return new Box3(new Vector3(at.x + squares.x0, at.y + squares.y0, at.z), new Vector3(at.x + squares.x1, at.y + squares.y1, at.z + 8));
  }

  const ON_RENT: readonly DayKind[] = ['idle', 'work', 'paid', 'cover'];

  /** The site as it will stand and the crane up to its jib, with the calendar of its days on the lot. */
  function storyWide(): Pose | null {
    const days = calendarBox();
    if (!model || !days) return null;
    const foot = model.craneBase(new Vector3());
    const top = model.craneBounds(new Box3())?.max.z ?? 0;
    const mast = [-14, 14].flatMap((dx) => [-14, 14].flatMap((dy) => [0, top].map((z) => new Vector3(foot.x + dx, foot.y + dy, z))));
    return fitPoints([...cornersOf(model.siteBounds(new Box3(), false)), ...cornersOf(days), ...mast], STORY_FROM.azimuth, STORY_FROM.elevation, { pad: 0.05, withPanel: true });
  }

  /**
   * Each day of the crane's rental, from the first on rent to the last, on the site as the plan has it that day: the
   * whole site in view with the crane and its calendar, a moment on the first day, then the days go by while the camera
   * pushes in a little. On an idle day nothing moves; on a day of the steel the frame goes up.
   */
  function playRental(): void {
    if (!live || move || !model || !calendar) return;
    const rental = craneRental();
    if (!rental) return;
    if (focus !== null) setFocus(null);
    if (apartTarget > 0.5) setApart(0);
    clearSelection();
    deselectRows();
    hideHint();
    story ??= { playing: false, holdUntil: 0, emphasis: null, shown: 0, idleWanted: false, arrived: [], circling: false, holding: false, change: null, changeAt: 0, changeShown: false };
    stopPlaying();
    const first = rental.days[0]!.at;
    const last = rental.days[rental.days.length - 1]!.at;
    setDate(first + DAY_MS * 0.3);
    const arrive = context.reducedMotion ? 0.01 : MOVE_SECONDS;
    story.playing = true;
    story.holdUntil = performance.now() + (arrive + (context.reducedMotion ? 0 : STORY_HOLD)) * 1000;
    playUntil = last + DAY_MS * 0.62;
    playing = true;
    playButton.classList.add('is-playing');
    playButton.setAttribute('aria-label', 'Pause');
    overlay.classList.add('is-story');
    writeReadout();
    const wide = storyWide();
    if (wide) {
      const seconds = rental.days.reduce((sum, day) => sum + STORY_DAY[day.kind], 0);
      glideTo(wide, arrive, () => {
        if (story?.playing) glideTo({ ...wide, distance: wide.distance * 0.9 }, seconds + STORY_HOLD);
      });
    }
    context.wake();
  }

  /** The play reached the last day on rent: the close look at the idle days, if Remy said them meanwhile. */
  function storyPlayed(): void {
    if (!story) return;
    story.playing = false;
    if (story.idleWanted) lookAtIdle();
  }

  function emphasizeDays(mode: CalendarEmphasis): void {
    if (!story || story.emphasis === mode) return;
    story.emphasis = mode;
    story.shown = 0;
    if (mode === null) calendar?.track.emphasize(null);
    calendarTag.classList.toggle('is-span', mode === 'span');
    calendarTag.classList.toggle('is-idle-focus', mode === 'idle');
    tagKey = '';
    context.wake();
  }

  /** Its days on rent stand out on the calendar, and her face goes to them: Remy says its dates. */
  function storySpan(): void {
    if (!story || !calendar || story.emphasis === 'idle' || story.change) return;
    emphasizeDays('span');
    attendBox(squaresBox(ON_RENT));
  }

  /** Its idle days stand out, each marked IDLE, and the camera goes in on them once the play has reached the last day. */
  function storyIdle(): Promise<void> {
    if (!story || !calendar || story.change) return Promise.resolve();
    emphasizeDays('idle');
    attendBox(squaresBox(['idle']));
    const there = new Promise<void>((resolve) => story!.arrived.push(resolve));
    if (story.playing) story.idleWanted = true;
    else lookAtIdle();
    return there;
  }

  /** Close on the idle days, through a long lens, so the way out can open it again. */
  function lookAtIdle(): void {
    if (!story) return;
    story.idleWanted = false;
    const arrived = () => {
      for (const resolve of story?.arrived.splice(0) ?? []) resolve();
    };
    const box = squaresBox(['idle']) ?? squaresBox(ON_RENT);
    if (!box) {
      arrived();
      return;
    }
    glideTo(fitPoints(cornersOf(box), IDLE_FROM.azimuth, IDLE_FROM.elevation, { pad: 0.36, withPanel: true, fov: LONG_LENS }), MOVE_SECONDS * 1.5, arrived, LONG_LENS);
  }

  /**
   * Out from the idle days and around the site while the rental's dates change: the lens opens from long to the usual as
   * the camera closes in, so the days keep their size while the site opens up around them (a dolly zoom); then up into a
   * slow circle of the site, its frame up and the crane at work on the last day of the steel.
   */
  function storyPullBack(): void {
    if (!live || move || !model || !calendar) return;
    story ??= { playing: false, holdUntil: 0, emphasis: null, shown: 0, idleWanted: false, arrived: [], circling: false, holding: false, change: null, changeAt: 0, changeShown: false };
    story.circling = true;
    story.playing = false;
    story.idleWanted = false;
    for (const resolve of story.arrived.splice(0)) resolve();
    stopPlaying();
    const moving = (glide || dolly) && lastPose ? lastPose : null;
    const riding = ride ? (lastPose ?? ride.to) : null;
    if (ride) endRide();
    const from = riding ?? (orbit || risingToFly ? stopOrbit() : (moving ?? context.takeFromControls()));
    glide = null;
    dolly = null;
    context.takeFromControls();
    const fov = camera.fov;
    if (context.reducedMotion || fov >= FOV - 0.5) riseToCircle(from);
    else dolly = { t: 0, seconds: DOLLY_SECONDS, from, fromFov: fov, toFov: FOV, after: riseToCircle };
    context.wake();
  }

  /**
   * Close on the calendar for the change of dates, and stays: every week of it, the dates large, through the long lens
   * the idle days were looked at with, so it's a small settling and not a move. Room is left under it, above the call,
   * for what the change saved.
   */
  function storyHold(): void {
    if (!live || move || !model || !calendar) return;
    story ??= { playing: false, holdUntil: 0, emphasis: null, shown: 0, idleWanted: false, arrived: [], circling: false, holding: false, change: null, changeAt: 0, changeShown: false };
    story.holding = true;
    story.circling = false;
    story.playing = false;
    story.idleWanted = false;
    for (const resolve of story.arrived.splice(0)) resolve();
    stopPlaying();
    overlay.classList.add('is-story', 'is-holding');
    // The date the view had reached says nothing here, and could only contradict the new dates: the calendar has them.
    readout.style.display = 'none';
    if (!story.change) emphasizeDays('idle');
    attendBox(squaresBox(['idle']) ?? calendarBox());
    const box = calendarBox();
    const { height } = context.size();
    const call = Number.isFinite(callTop) ? Math.max(0, height - (callTop - viewTop)) + 16 : 0;
    if (box) glideTo(fitPoints(cornersOf(box), IDLE_FROM.azimuth, IDLE_FROM.elevation, { pad: 0.03, withFloors: false, withPanel: true, fov: LONG_LENS, below: call + HOLD_TAG_ROOM }), context.reducedMotion ? 0.01 : MOVE_SECONDS * 1.2, undefined, LONG_LENS);
    writeReadout();
    context.wake();
  }

  /**
   * The circle round the crane's calendar: about a point a third of the way from it to the building, as far off as puts
   * the calendar at a fifth of the room across, as high as the fly-around goes on each side (over the tall neighbors).
   */
  function circleWay(azimuth: number): { pose: Pose; center: Vector3; middle: Spot; lens: Optics } | null {
    const days = calendarBox();
    if (!model || !days) return null;
    const building = model.siteBounds(new Box3(), false).getCenter(new Vector3());
    const center = days.getCenter(new Vector3()).lerp(new Vector3(building.x, building.y, 0), 0.4);
    center.z = 24;
    const { middle, lens } = roomFrame(openRoom(false, true));
    const lean = flyLean(azimuth) + CIRCLE_LEAN;
    const across = fitPoints(cornersOf(days), azimuth, lean, { pad: 0, withFloors: false, withPanel: true }).distance;
    const distance = across / CIRCLE_SHARE;
    return { pose: aroundPose(center, azimuth, lean, distance, middle, lens), center, middle, lens };
  }

  /** Up from where the camera is into the circle round the crane's calendar, then round it, slowly. */
  function riseToCircle(at: Pose): void {
    if (!live || move) return;
    // The frame up and the crane at work: the steel's last day.
    const lastWork = craneRental()?.days.filter((day) => day.kind === 'work').at(-1);
    if (lastWork) setDate(lastWork.at + DAY_MS * 0.62);
    const way = circleWay(at.azimuth);
    if (!way) return;
    const start = way.pose;
    glide = {
      from: at,
      to: start,
      t: 0,
      seconds: context.reducedMotion ? 0.01 : RISE_SECONDS,
      fromFov: camera.fov,
      toFov: FOV,
      after: () => {
        if (!live || move || !story?.circling) return;
        context.takeFromControls();
        orbit = { center: way.center, middle: way.middle, lens: way.lens, from: start, t: 0, seconds: context.reducedMotion ? 0.01 : CIRCLE_SECONDS, last: start, turn: CIRCLE_TURN, lean: CIRCLE_LEAN };
        flyLook(true);
        context.wake();
      },
    };
  }

  /** New dates have folded the old days away: what they saved is on screen, and the days on rent now stand out. */
  function showChange(): void {
    if (!story?.change) return;
    story.changeShown = true;
    emphasizeDays('span');
    attendBox(calendarBox());
    tagKey = '';
  }

  let tagKey = '';
  /** The tag's height, measured once each time its words change, for where it fits. */
  let tagHeight = 96;
  let tagHeightKey = '';
  /** Over the calendar: the machine and its dates, what its days come to, and what new dates saved while it was told. */
  function writeCalendarTag(booking: Booking, site: SiteTask): void {
    const rate = booking.machine.rateMinor;
    const summary = rentalSummary(site.days, rate);
    const name = `${booking.machine.name}: ${SHORT_DATE.format(booking.machine.booked[0])} to ${SHORT_DATE.format(booking.machine.booked[1] - DAY_MS)}`;
    const change = story?.changeShown ? story.change : null;
    let words: string;
    if (!summary) words = '';
    else if (!story) {
      const idle = site.days.filter((day) => day.kind === 'idle');
      const cost = idle.reduce((sum, day) => sum + day.costMinor, 0);
      words = idle.length > 0 ? `${idle.length} ${idle.length === 1 ? 'day' : 'days'} with nothing to lift${cost > 0 ? ` · ${money(cost)}` : ''}` : 'On rent only for its work';
    } else words = `${summary.days} days on rent${change && change.before.days !== summary.days ? ` (was ${change.before.days})` : ''} · ${spendWords(summary, rate > 0 ? money : null)}`;
    const saved = change ? savedWords(change, money) : null;
    if (story) writeDayStrip(daysOnRent(site.days), booking.task.color);
    else dayStrip.hidden = true;
    const key = `${name}|${words}|${saved ?? ''}`;
    if (key === tagKey) return;
    tagKey = key;
    tagTitle.textContent = name;
    tagWords.textContent = words;
    tagSaving.textContent = saved ?? '';
    tagSaving.hidden = !saved;
    calendarTag.classList.toggle('is-idle', Boolean(summary && summary.idle > 0));
  }

  let stripKey = '';
  let stripToday = -1;
  function writeDayStrip(days: readonly RentalDay[], workColor: string): void {
    dayStrip.hidden = false;
    const key = days.map((day) => `${day.at}:${day.kind}`).join('|');
    if (key !== stripKey) {
      const first = stripKey === '';
      stripKey = key;
      dayStrip.style.setProperty('--strip-work', workColor);
      const had = new Map([...(dayStrip.children as HTMLCollectionOf<HTMLElement>)].filter((cell) => !cell.classList.contains('is-gone')).map((cell) => [Number(cell.dataset.at), cell]));
      const now = new Map(days.map((day) => [day.at, day]));
      const all = [...new Set([...had.keys(), ...now.keys()])].sort((a, b) => a - b);
      // The days that change, earliest first, each in its turn: as the calendar on the lot turns them over.
      const changing = first ? [] : all.filter((at) => !had.has(at) || !now.has(at) || had.get(at)!.dataset.kind !== now.get(at)!.kind);
      let before: HTMLElement | null = null;
      for (const at of [...all].reverse()) {
        let cell = had.get(at);
        const day = now.get(at);
        const turn = changing.indexOf(at);
        const delay = turn < 0 ? 0 : (changing.length > 1 ? turn / (changing.length - 1) : 0) * 0.55 * FOLD_SECONDS;
        if (!cell) {
          cell = document.createElement('i');
          cell.dataset.at = String(at);
          dayStrip.insertBefore(cell, before);
          if (!first) cell.classList.add('is-new');
        }
        cell.style.transitionDelay = `${delay.toFixed(2)}s`;
        if (day) {
          const fresh = cell.classList.contains('is-new');
          cell.dataset.kind = day.kind;
          cell.className = `is-${day.kind}${fresh ? ' is-new' : ''}`;
        } else {
          cell.classList.add('is-gone');
          const gone = cell;
          window.setTimeout(() => gone.remove(), (delay + FOLD_SECONDS) * 1000);
        }
        before = cell;
      }
      // New days grow in from nothing, on the next frame.
      if (!first) requestAnimationFrame(() => dayStrip.querySelectorAll('.is-new').forEach((cell) => cell.classList.remove('is-new')));
      stripToday = -1;
    }
    // The date on show, while the days play.
    const today = story && !story.circling ? (days.find((day) => date >= day.at && date < day.at + DAY_MS)?.at ?? 0) : 0;
    if (today !== stripToday) {
      stripToday = today;
      for (const cell of dayStrip.children as HTMLCollectionOf<HTMLElement>) cell.classList.toggle('is-today', Number(cell.dataset.at) === today);
    }
  }

  /** What the film's walkthrough moves (rental-story.ts), in time with what is said on the call. */
  const stage_: RentalStage = {
    facts: rentalFacts,
    play: playRental,
    played: () => Boolean(story && !story.playing),
    span: storySpan,
    idle: storyIdle,
    pullBack: storyPullBack,
    holdOnCalendar: storyHold,
    changed: () => (story?.changeShown ? story.change : null),
  };

  // ---------------------------------------------------------------------------------------
  // The building at dusk, for the film (dusk.ts)
  // ---------------------------------------------------------------------------------------

  /** The shot under way, from the moment it was asked for. */
  let evening: { t: number; layers: readonly number[]; done: () => void } | null = null;
  /** The evening going back to the day. */
  let dawn: { t: number; seconds: number; from: number; done: () => void } | null = null;
  /** How far the evening has come down, 0 to 1. */
  let eveningNow = 0;
  /** How far each floor's lights are on, by layer, while the shot holds them. */
  const lightsOn = new Map<number, number>();
  /** The plan's paper at dusk: a slate blue, never black. */
  const EVENING_PAPER = new Color('#454850');
  /** What the plan's bars are multiplied by at dusk. */
  const EVENING_BARS = new Color('#4d5668');

  function setEvening(amount: number): void {
    eveningNow = amount;
    stage?.setDusk(amount);
    if (scene.background instanceof Color) scene.background.lerpColors(PAPER_COLOR, EVENING_PAPER, amount);
    groundPaper.material.color.lerpColors(PAPER_COLOR, EVENING_PAPER, amount);
    // Past the lot the paper and the background are one color; drawn, the plane would leave a line at the horizon.
    groundPaper.visible = amount < 0.5;
    groundShade.visible = amount < 0.5;
    groundBars.material.color.setRGB(1, 1, 1).lerp(EVENING_BARS, amount);
    groundShade.material.opacity = 0.14 * (1 - amount * 0.6);
  }

  /** The floors that have lights in them, lowest first, unless the view is still on its way in. */
  const duskFloors = () => (live && !move && model ? model.lightLayers() : []);

  /** The whole building from its front corner, low enough to look up at the lit ceilings through the glass. */
  function duskPose(): Pose {
    return model ? fitPoints(cornersOf(model.siteBounds(new Box3(), false)), -0.56, 1.42, { pad: 0.14, withFloors: false, withPanel: true }) : heroPose();
  }

  function playDusk(): Promise<void> {
    const layers = duskFloors();
    if (!model || !plan || layers.length === 0 || evening) return Promise.resolve();
    if (focus !== null) setFocus(null);
    if (apartTarget > 0.5) setApart(0);
    clearSelection();
    deselectRows();
    hideHint();
    stopPlaying();
    dawn = null;
    // The day those floors are all finished, whatever the bar the view came in through: every fixture up, and every
    // floor looks the same under them (paint and carpet in).
    const own = plan.parts.filter((part) => layers.includes(part.layer));
    setDate(Math.max(...own.map((part) => part.task.end)) + DAY_MS * 0.4);
    overlay.classList.add('is-dusk');
    lightsOn.clear();
    model.setFloorLights((layer) => lightsOn.get(layer) ?? 0);
    const seconds = context.reducedMotion ? 0.01 : 1;
    const wide = duskPose();
    glideTo(wide, seconds, () => {
      if (evening) glideTo({ ...wide, distance: wide.distance * 0.96 }, 3.2);
    });
    return new Promise((done) => {
      evening = { t: context.reducedMotion ? 60 : 0, layers, done };
      context.wake();
    });
  }

  function liftDusk(seconds = 0.6): Promise<void> {
    const shot = evening;
    evening = null;
    shot?.done();
    overlay.classList.remove('is-dusk');
    if (eveningNow <= 0) {
      model?.setFloorLights(null);
      return Promise.resolve();
    }
    return new Promise((done) => {
      dawn?.done();
      dawn = { t: 0, seconds: context.reducedMotion ? 0.01 : seconds, from: eveningNow, done };
      context.wake();
    });
  }

  /** Each frame, while the shot is on. */
  function runDusk(dt: number): void {
    if (evening) {
      evening.t += dt;
      const moment = duskAt(evening.t, evening.layers.length);
      setEvening(moment.evening);
      evening.layers.forEach((layer, index) => lightsOn.set(layer, moment.floors[index] ?? 0));
      if (moment.done) {
        const { done } = evening;
        evening = null;
        done();
      }
    }
    if (dawn) {
      dawn.t = Math.min(1, dawn.t + dt / dawn.seconds);
      setEvening(dawn.from * (1 - smooth(dawn.t)));
      if (dawn.t >= 1) {
        const { done } = dawn;
        dawn = null;
        model?.setFloorLights(null);
        done();
      }
    }
  }

  /** The view is going: nothing of the shot stays for the next visit. */
  function endDusk(): void {
    const waiting = [evening?.done, dawn?.done];
    evening = null;
    dawn = null;
    setEvening(0);
    model?.setFloorLights(null);
    lightsOn.clear();
    overlay.classList.remove('is-dusk');
    for (const done of waiting) done?.();
  }

  const dusk_: DuskStage = { floors: duskFloors, play: playDusk, lift: liftDusk };

  // ---------------------------------------------------------------------------------------
  // Apart, focus, the cutaway
  // ---------------------------------------------------------------------------------------

  function offsets(): number[] {
    if (!plan) return [];
    return plan.layers.map((layer) => apart * GAP * layer.index + (focus !== null && layer.index > focus ? lift * LIFT_CLEAR : 0));
  }

  function setApart(target: number): void {
    apartTarget = target;
    apartButton.classList.toggle('is-on', target > 0.5);
    apartButton.setAttribute('aria-pressed', String(target > 0.5));
    apartButton.querySelector('span')!.textContent = target > 0.5 ? 'Put back together' : 'Take apart';
    cutawayTarget = target > 0.5 || focus !== null || selected ? 1 : 0;
    glideTo(focus !== null ? storyPose(focus) : selected ? (posePiece([...selected]) ?? heroPose()) : heroPose());
    context.wake();
  }

  function setFocus(layer: number | null): void {
    focus = layer;
    // A story not built yet is still there, outlined: lit up while it is the one looked at.
    model?.setOutline(layer);
    cutawayTarget = layer !== null || apartTarget > 0.5 || selected ? 1 : 0;
    for (const item of floorList.children) item.classList.toggle('is-focus', Number((item as HTMLElement).dataset.layer) === layer);
    const name = layer !== null ? plan?.layers[layer]?.name : null;
    focusChip.hidden = !name;
    focusChip.replaceChildren();
    if (name) {
      const where = document.createElement('span');
      where.textContent = name;
      const way = document.createElement('b');
      way.textContent = 'Show all floors';
      const mark = document.createElement('i');
      mark.className = 'fa fa-xmark';
      mark.setAttribute('aria-hidden', 'true');
      focusChip.append(where, way, mark);
    }
    focusChip.setAttribute('aria-label', name ? `Leave ${name} and show all floors` : '');
    writeReadout();
    paint();
    context.wake();
  }

  /** A story's first day of work after `at`, if nothing of it is built by then; null once its work has begun. */
  function notBegunUntil(layer: number, at: number): number | null {
    if (!plan) return null;
    const own = plan.parts.filter((part) => part.layer === layer);
    if (own.length === 0 || own.some((part) => builtBy(part.task, at) > 0)) return null;
    return Math.min(...own.map((part) => part.task.start));
  }

  // ---------------------------------------------------------------------------------------
  // Paint: lens, selection, hover, what has landed
  // ---------------------------------------------------------------------------------------

  function payState(id: number): 'paid' | 'part' | 'owed' | 'open' | null {
    const site = sites.get(id);
    if (!site) return null;
    if (site.payout.state === 'paid') return 'paid';
    if (site.payout.state === 'moving' || site.payout.state === 'ready') return 'part';
    const check = site.payCheck;
    if (!check) return null;
    if (check.paidMinor > 0 && check.owedMinor <= 0) return 'paid';
    if (check.paidMinor > 0) return 'part';
    if (check.owedMinor > 0) return 'owed';
    return 'open';
  }

  let tones: Record<string, string> | null = null;
  function paint(): void {
    if (!model) return;
    const keepLayer = focus;
    const keep = selected && ghostSelection ? selected : null;
    const crewOf = new Map(tasks.map((task) => [task.id, task.crews[0]?.color ?? null]));
    const tiles = new Set((plan?.parts ?? []).filter((part) => part.kind === 'tiles').map((part) => part.task.id));
    tones ??= { paid: tokenColor('--paypal-blue') || '#0070e0', part: '#7fb0ea', owed: tokenColor('--warning') || '#c98a14', open: '#d9dde2' };
    const toneOf = tones;
    const hidden = hiddenNow;
    model.setPaint({
      keep:
        keep || keepLayer !== null
          ? (id, layer) => {
              if (keep) return keep.has(id) || shownWith.has(id);
              // The story looked into shows without its ceiling tiles, as a section does: the fixtures stay in their grid.
              if (layer === keepLayer && tiles.has(id)) return false;
              return keepLayer === null || layer <= keepLayer;
            }
          : null,
      tint: lens === 'firms' ? (id) => crewOf.get(id) ?? null : lens === 'money' ? (id) => toneOf[payState(id) ?? 'open'] ?? null : null,
      hover: hovered,
      hidden: hidden ? (id) => hidden.has(id) : null,
    });
    lensButtons.forEach(({ id, button }) => {
      button.classList.toggle('is-on', id === lens);
      button.setAttribute('aria-checked', String(id === lens));
    });
    writeLegend();
  }

  function setLens(next: Lens): void {
    lens = next;
    paint();
    writeFloorStates();
    context.wake();
  }

  /** The tasks a row stands for: itself, or every row under a group. */
  function rowsUnder(record: TaskModel): number[] {
    const task = original(record);
    if (task.isLeaf) return [task.id as number];
    const ids: number[] = [];
    walkTree(task, (node) => {
      if (node.isLeaf) ids.push(original(node).id as number);
    });
    return ids;
  }

  /** A group that is a whole story ("Level 2 build-out") opens that story; anything else is singled out where it is. */
  /**
   * The rows whose pieces show the chosen work: paint is the drywall's boards turning color, a lighting test is the
   * fixtures lighting up. Those stay solid with it while everything else fades.
   */
  let shownWith = new Set<number>();
  /** Whether the choice has pieces of its own: only then does everything else fade. */
  let ghostSelection = true;
  function companionsOf(ids: readonly number[]): Set<number> {
    const found = new Set<number>();
    if (!plan) return found;
    for (const id of ids) {
      const part = plan.parts.find((entry) => entry.task.id === id);
      if (!part) continue;
      const on = part.kind === 'paint' ? 'drywall' : part.kind === 'test' || part.kind === 'wiring' ? 'lights' : null;
      if (!on) continue;
      for (const other of plan.parts) if (other.kind === on && other.layer === part.layer) found.add(other.task.id);
    }
    return found;
  }

  /** The story a row's work is on, when it is one of the building's floors. */
  function storyOf(ids: readonly number[]): number | null {
    if (!plan) return null;
    const roof = roofOf(plan);
    for (const id of ids) {
      const layer = plan.parts.find((entry) => entry.task.id === id)?.layer;
      if (layer !== undefined && layer >= 1 && layer < roof) return layer;
    }
    return null;
  }

  function choose(record: TaskModel | null, frame = true): void {
    if (move) {
      if (record) wanted = rowsUnder(record);
      return;
    }
    if (!record || !plan || !model) {
      clearSelection();
      return;
    }
    const task = original(record);
    const story = plan.layers.find((layer) => layer.groupId === task.id);
    if (story) {
      selected = null;
      callout.hidden = true;
      setFocus(story.index);
      attendLayer(story.index);
      if (frame) glideTo(storyPose(story.index));
      return;
    }
    const ids = rowsUnder(record).filter((id) => tasks.some((entry) => entry.id === id));
    if (ids.length === 0) return;
    // Work with nothing of its own to draw (an order, a clean): its floor, opened up, with the card on it.
    if (!boxOf(ids)) {
      const layer = storyOf(ids);
      selected = new Set(ids);
      ghostSelection = false;
      shownWith = new Set();
      writeCallout(task.isLeaf ? null : (task.name ?? null));
      if (layer !== null) {
        setFocus(layer);
        attendLayer(layer);
        if (frame) glideTo(storyPose(layer));
      }
      paint();
      return;
    }
    selected = new Set(ids);
    ghostSelection = true;
    shownWith = companionsOf(ids);
    const floor = task.isLeaf ? storyOf(ids) : null;
    if (floor !== null) setFocus(floor);
    else {
      focus = null;
      focusChip.hidden = true;
      for (const item of floorList.children) item.classList.remove('is-focus');
    }
    cutawayTarget = 1;
    paint();
    writeCallout(task.isLeaf ? null : (task.name ?? null));
    attendBox(boxOf(ids));
    if (frame) {
      const pose = floor !== null ? storyPose(floor) : posePiece(ids);
      if (pose) glideTo(pose);
    }
  }

  /** The assistant's light goes to the top of this, or back to your shoulder with nothing. */
  function attendBox(box: Box3 | null): void {
    context.companion.attend(box);
  }

  /** A story's footprint, from its floor to the one above, where it is now. */
  function layerBox(index: number): Box3 | null {
    if (!model) return null;
    const center = model.layerCenter(index, new Vector3());
    const half = model.layerSpan(index).height / 2;
    return new Box3(new Vector3(center.x - 150, center.y - 100, center.z - half), new Vector3(center.x + 150, center.y + 100, center.z + half));
  }

  function attendLayer(index: number): void {
    context.companion.attend(layerBox(index));
  }

  function clearSelection(): void {
    selected = null;
    ghostSelection = true;
    shownWith = new Set();
    context.companion.attend(null);
    callout.hidden = true;
    cutawayTarget = focus !== null || apartTarget > 0.5 ? 1 : 0;
    paint();
  }

  /** Lets go of the row chosen in the plan too, so the two never disagree. */
  function deselectRows(): void {
    picking = true;
    try {
      (gantt as unknown as { deselectAll(): void }).deselectAll();
    } finally {
      picking = false;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Words on screen
  // ---------------------------------------------------------------------------------------

  function stateWords(task: PlanTask): string {
    const built = builtBy(task, date);
    if (built >= 1) return `Done by ${SHORT_DATE.format(task.end - 1)}`;
    if (built > 0) return 'Under way on this date';
    return `Starts ${SHORT_DATE.format(task.start)}`;
  }

  let readKey = '';
  function writeReadout(): void {
    if (!plan) return;
    const day = LONG_DATE.format(new Date(date));
    // The crane's rental being told: the date large, and what the crane is doing that day in a word.
    const rental = story ? craneRental() : null;
    const told = rental ? momentWords(rentalMoment(rental.days, date), rental.booking.machine.name) : null;
    readout.classList.toggle('is-story', Boolean(told));
    if (told) {
      const key = `${day}|${told.badge}|${told.text}`;
      if (key === readKey) return;
      readKey = key;
      readDate.textContent = day;
      const badge = document.createElement('span');
      badge.className = `fxb-day-badge is-${told.kind}`;
      badge.textContent = told.badge;
      readWhat.replaceChildren(badge, document.createTextNode(told.text));
      return;
    }
    readKey = '';
    readDate.textContent = day;
    // Looking at a story with nothing of it built yet: its outline, and when its own work starts.
    const looking = focus !== null ? plan.layers[focus] : null;
    const starts = looking ? notBegunUntil(looking.index, date) : null;
    if (looking && starts !== null) {
      readWhat.textContent = `${looking.name}: nothing built yet; its work starts ${SHORT_DAY.format(new Date(starts))}`;
      return;
    }
    const now = tasks.filter((task) => !task.milestone && date >= task.start && date < task.end);
    const handover = tasks.find((task) => task.milestone && /hand ?over/i.test(task.name));
    if (now.length > 0) {
      const first = now[0]!;
      const day = first.workDays.filter((at) => at <= date).length;
      readWhat.textContent = now.length > 1 ? `${first.name} and ${now.length - 1} more` : `${first.name} · day ${Math.max(1, day)} of ${first.workDays.length}`;
    } else if (handover && date >= handover.start) readWhat.textContent = 'Handed over to the tenant';
    else if (date < plan.span[0] + DAY_MS) readWhat.textContent = 'Before the work starts';
    else readWhat.textContent = 'Nothing planned on this day';
  }

  /**
   * Each story a payment gate holds, while it is not built by the date on show: a tag on its front saying what
   * it waits for, which opens the payment over the scene. Paying it there releases the story in the chart too.
   */
  function placeHoldTags(settled: boolean, width: number, height: number, project: (at: Vector3) => { x: number; y: number; behind: boolean }): void {
    if (!plan || !model) return;
    const holds: { gate: Gate; layer: number; name: string }[] = [];
    for (const gate of gateIndex(gantt.project as never).gates.values()) {
      if (!gate.holding) continue;
      for (const row of gate.holds) {
        // The story named for the held group, else the one most of its work builds (the slab: the ground floor).
        const rowId = row.id as number;
        const ofRow = plan.parts.filter((part) => part.task.id === rowId || part.task.pathIds.includes(rowId));
        const counts = new Map<number, number>();
        for (const part of ofRow) if (part.layer >= 0) counts.set(part.layer, (counts.get(part.layer) ?? 0) + 1);
        const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const layer = plan.layers.find((entry) => entry.groupId === row.id) ?? (most !== undefined ? plan.layers[most] : undefined);
        if (!layer) continue;
        const parts = ofRow.length > 0 && layer.groupId !== row.id ? ofRow : plan.parts.filter((part) => part.layer === layer.index);
        const built = parts.length > 0 && parts.every((part) => builtBy(part.task, date) >= 1);
        // A story by its own name; other held work (the slab on the ground floor) by the plan's.
        if (!built) holds.push({ gate, layer: layer.index, name: layer.groupId === row.id ? layer.name : (row.name ?? layer.name) });
      }
    }
    while (holdTags.children.length < holds.length) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'fxb-hold-tag';
      const lock = document.createElement('i');
      lock.className = 'fa fa-lock';
      lock.setAttribute('aria-hidden', 'true');
      const words = document.createElement('span');
      const due = document.createElement('b');
      tag.append(lock, words, due);
      tag.addEventListener('click', () => {
        const gate = gateIndex(gantt.project as never).gates.get(Number(tag.dataset.gate));
        if (gate) context.editTask(gate.task);
      });
      holdTags.append(tag);
    }
    // With work chosen, only the hold that work is part of (its story, or the payment itself) stays up.
    const store = (gantt.project as unknown as { taskStore: { getById(id: number): TaskModel | undefined } }).taskStore;
    const about = (gate: Gate) =>
      !selected ||
      [...selected].some((id) => {
        const task = store.getById(id);
        return id === gate.id || (task !== undefined && gate.holds.some((row) => row === task || (row as unknown as { contains(child: TaskModel): boolean }).contains(task)));
      });
    [...(holdTags.children as HTMLCollectionOf<HTMLButtonElement>)].forEach((tag, index) => {
      const hold = holds[index];
      if (!hold || !settled || !about(hold.gate)) {
        tag.hidden = true;
        return;
      }
      const box = layerBox(hold.layer);
      if (!box) {
        tag.hidden = true;
        return;
      }
      const front = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2 + model!.offsetOf(hold.layer));
      const at = project(front);
      tag.dataset.gate = String(hold.gate.id);
      const pays = hold.gate.pays.map((row) => row.name).join(', ');
      tag.querySelector('span')!.textContent = `${hold.name} waits for the ${pays} payment`;
      const due = look().canViewCosts ? paymentOf(hold.gate).dueMinor : 0;
      const state = hold.gate.payGate.state;
      const dueOn = dueDay(hold.gate);
      const when = dueOn ? `due ${SHORT_DAY.format(dueOn)}` : '';
      tag.querySelector('b')!.textContent = state === 'paying' ? 'PayPal is paying…' : [due > 0 ? wholeMoney(due, look().currency) : '', when].filter(Boolean).join(' ');
      tag.classList.toggle('is-paying', state === 'paying');
      tag.title = 'Open the payment';
      tag.hidden = at.behind || at.y < 80 || at.y > height - 90 || at.x < 0 || at.x > width;
      tag.style.transform = `translate(${Math.round(Math.min(width - 150, Math.max(150, at.x)))}px, ${Math.round(at.y)}px)`;
    });
  }

  function writeFloors(): void {
    if (!plan) return;
    floorList.replaceChildren();
    for (const layer of [...plan.layers].reverse()) {
      const item = document.createElement('li');
      item.dataset.layer = String(layer.index);
      const button = document.createElement('button');
      button.type = 'button';
      button.title = `Look into ${layer.name.toLowerCase()}`;
      const short = document.createElement('span');
      short.className = 'fxb-short';
      short.textContent = layer.short;
      const name = document.createElement('span');
      name.className = 'fxb-name';
      name.textContent = layer.name;
      const state = document.createElement('span');
      state.className = 'fxb-state';
      button.append(short, name, state);
      button.addEventListener('click', () => {
        if (focus === layer.index) {
          setFocus(null);
          glideTo(heroPose());
          return;
        }
        selected = null;
        callout.hidden = true;
        deselectRows();
        setFocus(layer.index);
        glideTo(storyPose(layer.index));
      });
      button.addEventListener('pointerenter', () => item.classList.add('is-near'));
      button.addEventListener('pointerleave', () => item.classList.remove('is-near'));
      item.append(button);
      floorList.append(item);
    }
    layerTags.replaceChildren();
    for (const layer of plan.layers) {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'fxb-layer-tag';
      tag.dataset.layer = String(layer.index);
      const code = document.createElement('b');
      code.textContent = layer.short;
      const words = document.createElement('span');
      words.textContent = layer.name;
      tag.append(code, words);
      tag.addEventListener('click', () => (floorList.querySelector(`li[data-layer="${layer.index}"] button`) as HTMLButtonElement | null)?.click());
      layerTags.append(tag);
    }
    writeFloorStates();
  }

  /** Each story's state on this date, in words: no share of the work, which the plan doesn't know. */
  function writeFloorStates(): void {
    if (!plan) return;
    for (const item of floorList.children as HTMLCollectionOf<HTMLElement>) {
      const layer = plan.layers[Number(item.dataset.layer)];
      const state = item.querySelector<HTMLElement>('.fxb-state');
      if (!layer || !state) continue;
      const parts = plan.parts.filter((part) => part.layer === layer.index || (part.layer === -1 && part.kind !== 'clean' && part.kind !== 'handover' && layer.index > 0 && layer.index <= plan!.stories));
      const built = parts.map((part) => builtBy(part.task, date));
      const done = built.length > 0 && built.every((value) => value >= 1);
      const going = built.some((value) => value > 0 && value < 1);
      const begun = built.some((value) => value > 0);
      const key = done ? 'done' : going ? 'going' : begun ? 'waiting' : 'ahead';
      state.dataset.state = key;
      state.title = key === 'done' ? 'Built by this date' : key === 'going' ? 'Work under way on this date' : key === 'waiting' ? 'Begun, nothing under way on this date' : 'Not started by this date';
      if (lens === 'money' && look().canViewCosts) {
        // A row that goes up every story (the steel, the glass) is shared among the stories, not counted on each.
        const total = parts.reduce((sum, part) => sum + (sites.get(part.task.id)?.money?.expected ?? 0) / (part.layer === -1 ? plan!.stories : 1), 0);
        state.textContent = total > 0 ? compactMoney(total, look().currency) : '';
      } else state.textContent = '';
    }
  }

  function writeRail(): void {
    if (!plan) return;
    const [start, end] = plan.span;
    const length = Math.max(DAY_MS, end - start);
    railTrack.replaceChildren();
    // One band per phase, in the chart's color, along the dates.
    const phases = new Map<number, { name: string; color: string; from: number; to: number }>();
    for (const task of tasks) {
      const phase = task.pathIds[0] ?? task.id;
      const entry = phases.get(phase) ?? { name: task.path[0] ?? task.name, color: task.color, from: task.start, to: task.end };
      entry.from = Math.min(entry.from, task.start);
      entry.to = Math.max(entry.to, task.end);
      phases.set(phase, entry);
    }
    for (const phase of phases.values()) {
      const band = document.createElement('span');
      band.className = 'fxb-band';
      band.style.left = `${((phase.from - start) / length) * 100}%`;
      band.style.width = `${Math.max(0.4, ((phase.to - phase.from) / length) * 100)}%`;
      band.style.setProperty('--band', phase.color);
      band.title = `${phase.name}: ${SHORT_DATE.format(phase.from)} to ${SHORT_DATE.format(phase.to - 1)}`;
      railTrack.append(band);
    }
    // A machine's idle days, in amber, over the phases.
    for (const booking of plan.bookings) {
      const [from, to] = booking.machine.booked;
      for (let at = from; at < to; at += DAY_MS) {
        if (at >= booking.task.start && at < booking.task.end) continue;
        const tick = document.createElement('span');
        tick.className = 'fxb-idle';
        tick.style.left = `${((at - start) / length) * 100}%`;
        tick.style.width = `${(DAY_MS / length) * 100}%`;
        tick.title = `${SHORT_DATE.format(at)}: ${booking.machine.name} booked, no work planned`;
        railTrack.append(tick);
      }
    }
    railMonths.replaceChildren();
    const first = new Date(start);
    for (let month = new Date(first.getFullYear(), first.getMonth() + 1, 1); month.getTime() < end; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
      const mark = document.createElement('span');
      mark.style.left = `${((month.getTime() - start) / length) * 100}%`;
      mark.textContent = MONTH.format(month);
      railMonths.append(mark);
    }
    writeRailHead();
  }

  function writeRailHead(): void {
    if (!plan) return;
    const [start, end] = plan.span;
    const at = (date - start) / Math.max(DAY_MS, end - start);
    railHead.style.left = `${Math.min(1, Math.max(0, at)) * 100}%`;
    railTip.textContent = SHORT_DATE.format(date);
    rail.setAttribute('aria-valuetext', LONG_DATE.format(new Date(date)));
  }

  function writeLegend(): void {
    if (lens === 'work') {
      legend.hidden = true;
      return;
    }
    legend.hidden = false;
    legend.replaceChildren();
    const add = (color: string, text: string) => {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = color;
      item.append(dot, text);
      legend.append(item);
    };
    if (lens === 'firms') {
      const seen = new Map<string, string>();
      for (const task of tasks) for (const crew of task.crews.slice(0, 1)) if (!seen.has(crew.name)) seen.set(crew.name, crew.color);
      for (const [name, color] of seen) add(color, name);
    } else {
      add(tokenColor('--paypal-blue') || '#0070e0', 'Paid with PayPal');
      add('#7fb0ea', 'Payment on its way');
      add(tokenColor('--warning') || '#c98a14', 'Reported done, not paid');
      add('#d9dde2', 'Nothing owed yet');
    }
  }

  function writeCallout(groupName: string | null = null): void {
    // Nothing over the view from up on the crane (the plan changing meanwhile included): it comes back with the camera.
    // Not over a camera move that tells something: a ride on the crane, or the rental story's circle of the site (applying
    // the new dates picks the crane's task, and its card would sit in the shot).
    if (!selected || selected.size === 0 || !plan || ride || story?.circling) {
      callout.hidden = true;
      return;
    }
    const list = tasks.filter((task) => selected!.has(task.id));
    if (list.length === 0) {
      callout.hidden = true;
      return;
    }
    callout.replaceChildren();
    const head = document.createElement('div');
    head.className = 'fxb-callout-head';
    const title = document.createElement('strong');
    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'fxb-x';
    shut.setAttribute('aria-label', 'Close and show everything');
    shut.title = 'Close (Esc)';
    shut.innerHTML = '<i class="fa fa-xmark" aria-hidden="true"></i>';
    shut.addEventListener('click', () => {
      clearSelection();
      deselectRows();
      glideTo(focus !== null ? storyPose(focus) : heroPose());
    });
    head.append(title, shut);
    const sub = document.createElement('span');
    if (list.length === 1) {
      const task = list[0]!;
      title.textContent = task.name;
      const crew = task.crews[0]?.name;
      sub.textContent = `${datesOf(task)}${crew ? ` · ${crew}` : ''}`;
    } else {
      title.textContent = groupName ?? list[0]!.path[list[0]!.path.length - 1] ?? 'These rows';
      sub.textContent = `${list.length} rows · ${SHORT_DATE.format(Math.min(...list.map((task) => task.start)))} to ${SHORT_DATE.format(Math.max(...list.map((task) => task.end)) - 1)}`;
    }
    const state = document.createElement('span');
    state.className = 'fxb-callout-state';
    state.textContent = list.length === 1 ? stateWords(list[0]!) : `${list.filter((task) => builtBy(task, date) >= 1).length} of ${list.length} done by this date`;
    callout.append(head, sub, state);
    if (look().canViewCosts) {
      const cost = list.reduce((sum, task) => sum + (sites.get(task.id)?.money?.expected ?? 0), 0);
      const paidMinor = list.reduce((sum, task) => sum + (sites.get(task.id)?.money?.paid ?? 0), 0);
      if (cost > 0) {
        const line = document.createElement('span');
        line.className = 'fxb-money';
        line.textContent = paidMinor > 0 ? `${money(cost)} · ${money(paidMinor)} paid` : `${money(cost)} · nothing paid yet`;
        callout.append(line);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'fxb-actions';
    const when = document.createElement('button');
    when.type = 'button';
    when.textContent = 'Play its days';
    when.title = 'Watch it go up, from its first day to its last';
    when.addEventListener('click', () => {
      stopPlaying();
      const first = Math.min(...list.map((task) => task.start));
      const last = Math.max(...list.map((task) => (task.workDays.length > 0 ? task.workDays[task.workDays.length - 1]! + DAY_MS * 0.9 : task.end)));
      playDays(midnight(first), last);
    });
    actions.append(when);
    if (list.length === 1) {
      const record = records.get(list[0]!.id);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => record && context.editTask(record));
      actions.append(edit);
      const site = sites.get(list[0]!.id);
      if (record && context.openPayment && site && site.days.some((day) => day.costMinor > 0)) {
        const pay = document.createElement('button');
        pay.type = 'button';
        pay.className = 'is-pay';
        pay.textContent = 'Rental and payment';
        pay.addEventListener('click', () => record && context.openPayment?.(record));
        actions.append(pay);
      }
    }
    callout.append(actions);
    callout.hidden = false;
  }

  let toastTimer = 0;
  function showToast(text: string, action?: { label: string; run(): void }): void {
    toast.replaceChildren();
    const words = document.createElement('span');
    words.textContent = text;
    toast.append(words);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        toast.hidden = true;
        action.run();
      });
      toast.append(button);
    }
    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'fxb-x is-inverse';
    shut.setAttribute('aria-label', 'Dismiss');
    shut.innerHTML = '<i class="fa fa-xmark" aria-hidden="true"></i>';
    shut.addEventListener('click', () => (toast.hidden = true));
    toast.append(shut);
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), action ? 14_000 : 6000);
  }

  // ---------------------------------------------------------------------------------------
  // The plan's rows, beside the building: what each is doing on the date, and which one is pointed at
  // ---------------------------------------------------------------------------------------

  const ROW_CLASSES = ['fxb-row-done', 'fxb-row-now', 'fxb-row-ahead', 'fxb-row-near'];
  function markRows(): void {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const row of gantt.element.querySelectorAll<HTMLElement>('.b-grid-sub-grid-locked .b-grid-row')) {
      const record = (gantt as unknown as { getRecordFromElement(element: HTMLElement): TaskModel | null }).getRecordFromElement(row);
      const id = record ? (original(record).id as number) : null;
      const ids = record && !record.isLeaf ? rowsUnder(record) : id !== null ? [id] : [];
      const states = ids
        .map((each) => byId.get(each))
        .filter((task): task is PlanTask => Boolean(task))
        .map((task) => builtBy(task, date));
      const done = states.length > 0 && states.every((value) => value >= 1);
      const now = states.some((value) => value > 0 && value < 1);
      row.classList.toggle('fxb-row-done', live && done);
      row.classList.toggle('fxb-row-now', live && now);
      row.classList.toggle('fxb-row-ahead', live && states.length > 0 && !done && !now);
      row.classList.toggle('fxb-row-near', live && hovered !== null && id === hovered);
    }
  }

  function unmarkRows(): void {
    for (const row of gantt.element.querySelectorAll<HTMLElement>('.b-grid-row')) row.classList.remove(...ROW_CLASSES);
  }

  function listenToRows(): () => void {
    const events = gantt as unknown as { on(listeners: Record<string, unknown>): () => void };
    return events.on({
      cellMouseOver: ({ record }: { record?: TaskModel }) => {
        if (!live || move || !record) return;
        const next = original(record).isLeaf ? (original(record).id as number) : null;
        if (next !== hovered) {
          hovered = next;
          paint();
          rowsAt = 0;
          context.wake();
        }
      },
      cellMouseOut: () => {
        if (!live || hovered === null) return;
        hovered = null;
        paint();
        rowsAt = 0;
        context.wake();
      },
      selectionChange: ({ selection }: { selection?: TaskModel[] }) => {
        // Held on the calendar for a change of dates: applying it selects its task, and the camera stays.
        if (!live || picking || story?.holding) return;
        const record = selection?.[selection.length - 1] ?? null;
        choose(record);
      },
    });
  }

  // ---------------------------------------------------------------------------------------
  // The rail: drag or click a date, keys to step a day
  // ---------------------------------------------------------------------------------------

  const railDate = (clientX: number) => {
    if (!plan) return date;
    const rect = railTrack.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return midday(plan.span[0] + t * (plan.span[1] - plan.span[0]));
  };
  rail.addEventListener('pointerdown', (event) => {
    stopPlaying();
    rail.setPointerCapture(event.pointerId);
    setDate(railDate(event.clientX));
    rail.classList.add('is-dragging');
  });
  rail.addEventListener('pointermove', (event) => {
    if (rail.hasPointerCapture(event.pointerId)) setDate(railDate(event.clientX));
  });
  rail.addEventListener('pointerup', (event) => {
    rail.releasePointerCapture(event.pointerId);
    rail.classList.remove('is-dragging');
  });
  rail.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 7 : 1;
    if (event.key === 'ArrowRight') setDate(midday(date + step * DAY_MS));
    else if (event.key === 'ArrowLeft') setDate(midday(date - step * DAY_MS));
    else if (event.key === ' ') togglePlay();
    else return;
    if (event.key !== ' ') stopPlaying();
    event.preventDefault();
  });

  // ---------------------------------------------------------------------------------------
  // The ground: the plan the site stands on, and its bars as blocks for the way in and out
  // ---------------------------------------------------------------------------------------

  /**
   * Where the chart's pixels lie on the ground. The bar gone through is the middle of the site, and a pixel of the
   * chart is GROUND_SCALE of the scene's units, so the lot that grows out of the bar is much larger than the bar.
   */
  let anchor = { x: 0, y: 0 };
  const onGround = (x: number, y: number): Vector3 => new Vector3((x - anchor.x) * GROUND_SCALE, (anchor.y - y) * GROUND_SCALE, GROUND_Z);

  /** The plan as the ground: its paper, every bar where it is on screen, and the shadows the site throws on them. */
  const groundPaper = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: PAPER_COLOR.clone() }));
  groundPaper.scale.set(80_000, 80_000, 1);
  groundPaper.position.z = GROUND_Z;
  const groundShade = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.14 }));
  groundShade.scale.set(80_000, 80_000, 1);
  groundShade.position.z = GROUND_Z + 1.2;
  groundShade.receiveShadow = true;
  const groundBars = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), GROUND_BARS);
  // Colored from the start, so its shader is the one the warm-up compiles.
  groundBars.setColorAt(0, new Color('#ffffff'));
  groundBars.count = 0;
  groundBars.frustumCulled = false;
  const ground = new Group();
  ground.name = 'The plan, as the ground';
  ground.add(groundPaper, groundBars, groundShade);
  ground.visible = false;
  scene.add(ground);
  /** Which of the ground's bars is each task's, so the one gone through can be lifted out of it. */
  const groundIndex = new Map<number, number>();
  const kept = new Map<number, Matrix4>();
  const placing = new Matrix4();
  const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
  const level = new Quaternion();
  const sized = new Vector3();
  const tone = new Color();
  const blockGeometry = new BoxGeometry(1, 1, 1);

  /** Every bar on the chart, groups and milestones too, as a flat bar on the ground in its own color. */
  function layGround(): void {
    const canvasBox = renderer.domElement.getBoundingClientRect();
    groundIndex.clear();
    kept.clear();
    let count = 0;
    for (const wrap of gantt.element.querySelectorAll<HTMLElement>('.b-gantt-task-wrap')) {
      if (count >= GROUND_BARS) break;
      const inner = wrap.querySelector<HTMLElement>('.b-gantt-task') ?? wrap;
      const rect = inner.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(inner);
      const fill = isClear(style.backgroundColor) ? style.borderTopColor : style.backgroundColor;
      if (isClear(fill)) continue;
      const center = onGround(rect.left + rect.width / 2 - canvasBox.left, rect.top + rect.height / 2 - canvasBox.top);
      center.z = GROUND_Z + 0.5;
      if (wrap.classList.contains('b-milestone-wrap')) {
        const side = Math.min(rect.width, rect.height) * 0.72 * GROUND_SCALE;
        placing.compose(center, turned, sized.set(side, side, 1));
      } else placing.compose(center, level, sized.set(rect.width * GROUND_SCALE, rect.height * GROUND_SCALE, 1));
      groundBars.setMatrixAt(count, placing);
      groundBars.setColorAt(count, tone.copy(cssColor(fill)));
      const record = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (record && !groundIndex.has(original(record).id as number)) groundIndex.set(original(record).id as number, count);
      count += 1;
    }
    groundBars.count = count;
    groundBars.instanceMatrix.needsUpdate = true;
    if (groundBars.instanceColor) groundBars.instanceColor.needsUpdate = true;
  }

  /** Takes a task's bar off the ground while its block is lifted out of it, or puts it back. */
  function liftGroundBar(id: number, lifted: boolean): void {
    const index = groundIndex.get(id);
    if (index === undefined) return;
    if (lifted) {
      if (!kept.has(id)) {
        const matrix = new Matrix4();
        groundBars.getMatrixAt(index, matrix);
        kept.set(id, matrix);
      }
      groundBars.setMatrixAt(index, placing.makeScale(0, 0, 0));
    } else {
      const matrix = kept.get(id);
      if (!matrix) return;
      groundBars.setMatrixAt(index, matrix);
      kept.delete(id);
    }
    groundBars.instanceMatrix.needsUpdate = true;
  }

  /** The bars on screen (or only this task's) as blocks lying over them on the ground, each with where its piece is. */
  function makeBlocks(only: number | null = null): Block[] {
    if (!model) return [];
    const canvasBox = renderer.domElement.getBoundingClientRect();
    const blocks: Block[] = [];
    for (const wrap of [...gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)].slice(0, 80)) {
      const inner = wrap.querySelector<HTMLElement>('.b-gantt-task');
      const record = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (!inner || !record) continue;
      const id = original(record).id as number;
      if (only !== null && id !== only) continue;
      const rect = inner.getBoundingClientRect();
      if (rect.width < 2 || rect.bottom < canvasBox.top || rect.top > canvasBox.bottom || rect.right < canvasBox.left || rect.left > canvasBox.right) continue;
      const box = model.boundsOf(id, bounds);
      const piece = box ? box.getCenter(new Vector3()) : model.layerCenter(1, new Vector3());
      const at = onGround(rect.left + rect.width / 2 - canvasBox.left, rect.top + rect.height / 2 - canvasBox.top);
      at.z = GROUND_Z + BLOCK_DEPTH / 2 + 1;
      const color = getComputedStyle(inner).backgroundColor;
      const side = new MeshBasicMaterial({ color: isClear(color) ? new Color('#8a96a3') : cssColor(color).multiplyScalar(0.86), transparent: true });
      const face = new MeshBasicMaterial({ map: context.makeBlockFace(wrap, inner), transparent: true });
      const mesh = new Mesh(blockGeometry, [side, side, side, side, face, side]);
      mesh.castShadow = true;
      mesh.renderOrder = 60;
      const size = new Vector2(rect.width * GROUND_SCALE, rect.height * GROUND_SCALE);
      mesh.scale.set(size.x, size.y, BLOCK_DEPTH);
      mesh.position.copy(at);
      scene.add(mesh);
      const painted = getComputedStyle(inner);
      const onScreen = { x: rect.left + rect.width / 2 - canvasBox.left - canvasBox.width / 2, y: rect.top + rect.height / 2 - canvasBox.top - canvasBox.height / 2, w: rect.width, h: rect.height, border: parseFloat(painted.borderTopWidth) || 0, radius: parseFloat(painted.borderTopLeftRadius) || 0 };
      blocks.push({ id, mesh, face, side, onScreen, bar: at, size, piece, delay: 0, span: 0.5 });
    }
    return blocks;
  }

  function dropBlocks(blocks: readonly Block[]): void {
    for (const block of blocks) {
      block.mesh.removeFromParent();
      block.face.map?.dispose();
      block.face.dispose();
      block.side.dispose();
    }
  }

  /** Bottom up: the foundations land first, the roof last; steel and glass go up through the middle of it. */
  function landingOrder(id: number): number {
    if (!plan) return 0.5;
    const roof = roofOf(plan);
    const part = plan.parts.find((entry) => entry.task.id === id);
    if (!part) return 0.5;
    if (part.layer === -1) return part.kind === 'steel' ? 0.32 : part.kind === 'curtainwall' ? 0.62 : 0.9;
    return part.layer / roof;
  }

  async function scrollTo(record: TaskModel): Promise<void> {
    try {
      await (gantt as unknown as { scrollTaskIntoView(task: TaskModel, options: object): Promise<void> }).scrollTaskIntoView(record, { block: 'nearest', edgeOffset: 80, animate: false });
    } catch {
      // Collapsed or filtered out: it goes the usual way.
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  /** The bar of a task on screen now, if it is drawn. */
  function barRectOf(record: TaskModel): DOMRect | null {
    for (const wrap of gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)) {
      const found = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (found && original(found) === record) {
        const rect = (wrap.querySelector<HTMLElement>('.b-gantt-task') ?? wrap).getBoundingClientRect();
        return rect.width > 0 ? rect : null;
      }
    }
    return null;
  }

  /**
   * The bar to go in through when none was named: a row chosen in the plan, then the crane's work, then the bar
   * nearest the middle of the chart.
   */
  function barToEnter(next: BuildingPlan): TaskModel | null {
    const chosen = ((gantt as unknown as { selectedRecords?: TaskModel[] }).selectedRecords ?? []).map((record) => original(record)).find((record) => record.isLeaf && records.has(record.id as number));
    if (chosen) return chosen;
    const crane = next.bookings.find((booking) => booking.machine.kind === 'crane');
    if (crane && records.has(crane.task.id)) return records.get(crane.task.id)!;
    const box = gantt.element.getBoundingClientRect();
    let best: TaskModel | null = null;
    let nearest = Infinity;
    for (const wrap of gantt.element.querySelectorAll<HTMLElement>(BAR_SELECTOR)) {
      const record = gantt.resolveTaskRecord(wrap) as TaskModel | null;
      if (!record || !records.has(original(record).id as number)) continue;
      const rect = wrap.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - (box.left + box.width / 2), rect.top + rect.height / 2 - (box.top + box.height / 2));
      if (distance < nearest) {
        nearest = distance;
        best = original(record);
      }
    }
    return best;
  }

  /** A group goes in through its first row that has a piece. */
  function firstRowOf(group: TaskModel): TaskModel | null {
    const ids = rowsUnder(group);
    const first = tasks.filter((task) => ids.includes(task.id)).sort((a, b) => a.start - b.start)[0];
    return first ? (records.get(first.id) ?? null) : null;
  }

  /** The page under the scene: it fades as the plan's chrome dissolves into its bars, and comes back at the end. */
  function pageShown(value: number): void {
    document.documentElement.style.setProperty('--fxb-page', value.toFixed(3));
  }

  /** Whatever side panel is open in the page comes over the scene with it, and so does any opened while it is up. */
  let panelWatch: MutationObserver | null = null;
  /** The tab the page's side panel showed when last looked at: a panel comes over the scene when a tab opens. */
  let pageTab: string | null = null;
  function liftPanel(force = false): void {
    const tab = document.querySelector<HTMLElement>('.inspector-host .inspector-panel')?.dataset.tab ?? null;
    const opened = tab !== null && tab !== pageTab;
    pageTab = tab;
    if (!live || move || context.panel.isOpen() || !tab) return;
    if (opened || force) context.panel.liftAsIs();
  }
  function watchPanel(): void {
    panelWatch?.disconnect();
    const host = document.querySelector('.inspector-host');
    if (!host) return;
    pageTab = document.querySelector<HTMLElement>('.inspector-host .inspector-panel')?.dataset.tab ?? null;
    panelWatch = new MutationObserver(() => liftPanel());
    panelWatch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tab'] });
  }

  // ---------------------------------------------------------------------------------------
  // The view's life: in through a bar, and back out onto the plan
  // ---------------------------------------------------------------------------------------

  async function open(work?: TaskModel): Promise<void> {
    if (live) return;
    const next = read();
    if (!next) return;
    live = true;
    leaving = false;
    rentalStage.set(stage_);
    duskStage.set(dusk_);
    // Only ever in through a bar: the one asked for (a group's first row), or one chosen for it.
    const asked = work ? original(work) : null;
    const through = (asked && asked.isLeaf && records.has(asked.id as number) ? asked : asked ? firstRowOf(asked) : null) ?? barToEnter(next);
    const room = insetRect();
    // The bar is brought on screen first, so the way in starts from where it is drawn.
    if (through) await scrollTo(through);
    // People are real models or nobody stands on site; give them a moment to arrive.
    await Promise.race([context.workersReady, new Promise((resolve) => setTimeout(resolve, 2500))]);
    const nextShape = shapeOf(tasks);
    const [start, end] = next.span;
    const today = planClock.now().getTime();
    const target = asked ? tasks.find((task) => task.id === (asked.id as number)) : null;
    // A rental with idle days opens on its first idle day; other work on its first day; a group on its first row's;
    // the building on today, or finished when the work is all ahead of today.
    const firstIdle = (task: PlanTask | null | undefined) => {
      if (!task?.machine) return null;
      const [from, to] = task.machine.booked;
      for (let at = from; at < to; at += DAY_MS) if (at < task.start || at >= task.end) return midday(at);
      return null;
    };
    const groupLast = asked && !asked.isLeaf ? tasks.filter((task) => rowsUnder(asked).includes(task.id)).sort((a, b) => b.end - a.end)[0] : null;
    const enteredBy = !asked && through ? tasks.find((task) => task.id === (through.id as number)) : null;
    // Late on the last working day: the piece is all but done, so there is something to see.
    const lastDay = (task: PlanTask) => {
      const day = task.workDays[task.workDays.length - 1];
      return day !== undefined ? day + DAY_MS * 0.8 : midday(task.start);
    };
    date = target ? (firstIdle(target) ?? lastDay(target)) : groupLast ? lastDay(groupLast) : enteredBy ? (firstIdle(enteredBy) ?? lastDay(enteredBy)) : (keptDate ?? (today >= start && today <= end ? midday(today) : end));
    context.setAtmosphere(0, 1000);
    context.showTable(0, 0, 0, 1, 0, 0);
    scene.background = PAPER_COLOR.clone();
    if (stage) stage.dress();
    else stage = createStage(renderer, scene, camera, host.lights);
    stage.fitShadow(new Vector3(0, -40, 0), 900);
    stage.setQuality(quality);
    stage.setOcclusion(0);
    renderer.domElement.style.opacity = '0';
    document.documentElement.classList.add('fxb-full');
    pageShown(1);
    place(room);
    // Built already, for the last visit or ahead of the first, and the plan's shape is the same: shown again as it is.
    if (model && nextShape === shape) showAgain(next);
    else {
      shape = nextShape;
      build(next);
    }
    lastIdle = idleTotals();
    overlay.hidden = false;
    overlay.classList.remove('is-shown');
    context.setLive(true);
    rowListeners = listenToRows();
    setDate(date);
    // The bar gone through is the middle of the site; the plan's other bars lie around it as the ground.
    const canvasBox = renderer.domElement.getBoundingClientRect();
    const bar = through ? barRectOf(through) : null;
    anchor = bar ? { x: bar.left + bar.width / 2 - canvasBox.left, y: bar.top + bar.height / 2 - canvasBox.top } : { x: canvasBox.width / 2, y: canvasBox.height / 2 };
    layGround();
    ground.visible = true;
    const block = through ? (makeBlocks(through.id as number)[0] ?? null) : null;
    startDive(through, block, asked ?? through);
    watchPanel();
    context.wake();
  }

  /** The lot's footprint as it starts to grow: the bar's. */
  let seed = { w: 80, d: 80 };

  /**
   * The lot between the bar it grows out of and the site: `spread` 0 is the bar's footprint and 1 the lot's, `rise`
   * 0 flat on the plan and 1 standing. It grows from the bottom of its base, which never leaves the ground.
   */
  function shapeLot(spread: number, rise: number): void {
    if (!model) return;
    const sx = lerp(seed.w / BASE_SIZE.w, 1, spread);
    const sy = lerp(seed.d / BASE_SIZE.d, 1, spread);
    const sz = lerp(FLAT, 1, rise);
    model.root.scale.set(sx, sy, sz);
    model.root.position.set(0, 0, GROUND_Z * (1 - sz));
  }

  /**
   * In through a bar. The page's chrome dissolves into the plan's paper, leaving its bars where they were; the bar
   * lifts off it, grows flat into the lot, and the site springs up out of it as the camera dives toward it and leans
   * over into the view of it. One number runs it all, so it can be stopped and turned around anywhere.
   */
  function startDive(through: TaskModel | null, block: Block | null, focusOn: TaskModel | null): void {
    if (!model || !plan) return;
    cameThrough = through ? (through.id as number) : null;
    const rest = restNow();
    // Where it lands is worked out while the site stands at its full size.
    shapeLot(1, 1);
    model.root.updateMatrixWorld(true);
    const story = focusOn ? plan.layers.find((layer) => layer.groupId === (focusOn.id as number)) : undefined;
    const rows = focusOn ? rowsUnder(focusOn) : [];
    const floor = focusOn && !story && focusOn.isLeaf ? storyOf(rows) : null;
    const to = (story ? storyPose(story.index) : floor !== null ? storyPose(floor) : focusOn ? posePiece(rows) : null) ?? heroPose();
    hiddenNow = null;
    paint();
    if (block) liftGroundBar(block.id, true);
    seed = block ? { w: block.size.x, d: block.size.y } : { w: 80, d: 80 };
    shapeLot(0, 0);
    model.root.visible = false;
    if (block) digWell();
    move = {
      kind: 'dive',
      t: 0,
      seconds: context.reducedMotion ? 0.01 : block ? DIVE_SECONDS : GLIDE_SECONDS,
      from: rest,
      to,
      blocks: block ? [block] : [],
      at: new Map(),
      through: block,
      ...(focusOn ? { after: () => choose(focusOn, false) } : {}),
    };
  }

  function close(after?: () => void): void {
    if (!live || leaving) return;
    leaving = true;
    stopPlaying();
    // A dusk still up goes back to the day on the way out: the way out ends on the plan's own paper.
    if (evening || eveningNow > 0) void liftDusk(0.5);
    // Down off the crane, or out of a fly-around, from where the camera is: mid-move, where the move had got to.
    const riding = ride || glide || dolly ? lastPose : null;
    // The way out is drawn with the usual lens: from a long one, the camera moves back by as much, so nothing jumps.
    const wasFov = camera.fov;
    dolly = null;
    setFov(FOV);
    endRide();
    if (orbit || risingToFly) stopOrbit();
    context.companion.attend(null);
    keptDate = date;
    glide = null;
    if (move) finishMove(true);
    overlay.classList.remove('is-shown');
    hoverTip.hidden = true;
    toast.hidden = true;
    panelWatch?.disconnect();
    panelWatch = null;
    context.panel.close();
    const start = riding ?? context.takeFromControls();
    const from = Math.abs(wasFov - FOV) < 1e-3 ? start : { ...start, distance: (start.distance * halfTan(wasFov)) / halfTan(FOV) };
    const done = () => {
      finish();
      after?.();
    };
    if (context.reducedMotion || !model) {
      done();
      return;
    }
    // The plan as it is now lies under the site, and each bar on screen is somewhere for its piece to go back to.
    layGround();
    if (cameThrough !== null) liftGroundBar(cameThrough, true);
    startReturn(makeBlocks(), from, restNow(), done);
    context.wake();
  }

  /**
   * Out: the pieces come apart from the top down and fly back to their bars on the plan, the lot sinks into the plan
   * and draws back into the bar it grew out of, the camera rises back over the chart, and the page's chrome comes
   * back around the bars.
   */
  function startReturn(blocks: Block[], from: Pose, rest: Pose, after: () => void): void {
    const at = new Map<number, number>();
    for (const block of blocks) {
      block.delay = 0.04 + 0.34 * (1 - landingOrder(block.id)) + ((block.id * 37) % 7) / 300;
      block.span = 0.36;
      block.mesh.visible = false;
      at.set(block.id, block.delay);
    }
    hiddenNow = new Set();
    move = { kind: 'return', t: 0, seconds: RETURN_SECONDS, from, to: rest, blocks, at, through: null, after };
  }

  /** Ends a move where it is going; `cut` drops it at once (another move took over). */
  function finishMove(cut = false): void {
    const ending = move;
    if (!ending) return;
    move = null;
    if (ending.kind === 'dive') {
      fillWell();
      renderer.domElement.style.removeProperty('clip-path');
      camera.clearViewOffset();
      context.sheetTransform(null);
      document.querySelector<HTMLElement>('.app-header')?.style.removeProperty('opacity');
      setFov(FOV);
    }
    dropBlocks(ending.blocks);
    hiddenNow = null;
    shapeLot(1, 1);
    if (model) model.root.visible = true;
    paint();
    if (cut) return;
    if (ending.kind === 'dive') {
      renderer.domElement.style.opacity = '1';
      pageShown(0);
      context.handToControls(ending.to, undefined, ending.to.distance * 1.6);
      stage?.setOcclusion(1);
      overlay.classList.add('is-shown');
      wakeControls();
      liftPanel(true);
      ending.after?.();
      if (wanted) {
        const ids = wanted;
        wanted = null;
        if (ids.length > 0) show(ids);
        else planChanged();
      }
    } else ending.after?.();
  }

  function finish(): void {
    if (move) finishMove(true);
    glide = null;
    orbit = null;
    risingToFly = false;
    // The crane's rental, told or not, is put away with the view.
    story = null;
    dolly = null;
    setFov(FOV);
    overlay.classList.remove('is-story', 'is-holding');
    readout.classList.remove('is-story');
    readout.style.removeProperty('display');
    calendarTag.classList.remove('is-span', 'is-idle-focus', 'is-under', 'is-over');
    idleTag.hidden = true;
    dayStrip.replaceChildren();
    dayStrip.hidden = true;
    stripKey = '';
    stripToday = -1;
    tagKey = '';
    readKey = '';
    if (rentalStage.get() === stage_) rentalStage.set(null);
    endDusk();
    if (duskStage.get() === dusk_) duskStage.set(null);
    window.clearTimeout(closerTimer);
    window.clearTimeout(idleTimer);
    flyLook(false);
    window.clearTimeout(hintTimer);
    hint.hidden = true;
    hint.classList.remove('is-shown');
    document.documentElement.classList.remove('fx3d-covered', 'fxb-full');
    document.documentElement.style.removeProperty('--fxb-page');
    document.documentElement.style.removeProperty('--fxb-top');
    live = false;
    leaving = false;
    if (cameThrough !== null) liftGroundBar(cameThrough, false);
    cameThrough = null;
    rowListeners?.();
    rowListeners = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    panelWatch?.disconnect();
    panelWatch = null;
    context.panel.close(true);
    unmarkRows();
    // Kept out of sight for the next visit: built, compiled and uploaded once.
    if (model) model.root.visible = false;
    ground.visible = false;
    dropCalendar();
    stage?.restore();
    scene.background = null;
    overlay.hidden = true;
    callout.hidden = true;
    focusChip.hidden = true;
    hoverTip.hidden = true;
    floors.hidden = true;
    floorsButton.setAttribute('aria-pressed', 'false');
    selected = null;
    focus = null;
    hovered = null;
    apart = 0;
    apartTarget = 0;
    lift = 0;
    cutaway = 0;
    cutawayTarget = 0;
    placedWidth = 0;
    apartButton.classList.remove('is-on');
    apartButton.setAttribute('aria-pressed', 'false');
    apartButton.querySelector('span')!.textContent = 'Take apart';
    context.setLive(false);
  }

  // ---------------------------------------------------------------------------------------
  // Every frame
  // ---------------------------------------------------------------------------------------

  const flying = new Vector3();

  /** A block along its arc between a bar and a piece: `k` 0 is on the plan, 1 in the building. */
  function placeBlock(block: Block, k: number): void {
    const e = ease(k);
    flying.lerpVectors(block.bar, block.piece, e);
    flying.z += Math.sin(Math.PI * e) * 150;
    block.mesh.position.copy(flying);
    const shrink = 1 - 0.8 * e;
    block.mesh.scale.set(block.size.x * shrink, block.size.y * shrink, BLOCK_DEPTH * shrink);
  }

  /** The shorter way round from one heading to another. */
  const turnTo = (from: number, to: number) => {
    let delta = to - from;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  };

  function runMove(dt: number): Pose | null {
    const current = move!;
    current.t = Math.min(1, current.t + dt / current.seconds);
    const pose = current.kind === 'dive' ? runDive(current) : runReturn(current);
    if (current.t >= 1) {
      if (current.kind === 'return') renderer.domElement.style.opacity = '0';
      finishMove();
      return null;
    }
    return pose;
  }

  function runDive(current: Move): Pose {
    const u = current.t;
    if (current.through) return u < DIVE_SPLIT ? openBar(current.through, u / DIVE_SPLIT) : fallDownWell(current, (u - DIVE_SPLIT) / (1 - DIVE_SPLIT));
    // The page's chrome dissolves: the scene comes in over it with the plan's bars exactly where they were drawn.
    renderer.domElement.style.opacity = String(smooth(within(u, 0, 0.1)));
    if (u > 0.12) pageShown(0);
    return glideIn(current);
  }

  /** How high over the plan the camera is when the well's rim lies just outside this much of the view, in pixels. */
  function overWell(halfWidth: number, halfDepth: number): number {
    const focal = context.size().height / 2 / halfTan(WELL_LENS);
    return WELL_DEPTH + focal / Math.max(halfWidth / (BASE_SIZE.w / 2), halfDepth / (BASE_SIZE.d / 2), 0.14);
  }

  /**
   * The bar is the mouth of the well. The real chart comes up at the camera, the bar's face gives way, and what is under
   * it is the well, seen through the bar's own outline, which grows until there is nothing else to see.
   */
  function openBar(through: Block, t: number): Pose {
    const { width, height } = context.size();
    const { x, y, w, h, border, radius } = through.onScreen;
    const openW = Math.max(2, w - border * 2);
    const openH = Math.max(2, h - border * 2);
    const scale = Math.exp(Math.log(Math.max(width / openW, height / openH) * 1.03) * t ** 1.7);
    // The bar comes to the middle of the view, so it is falling straight into it by the time it is any size. The page
    // is scaled about its own middle, which is not the scene's when the header stands over the page and not the scene.
    const off = 1 - smooth(within(t, 0.05, 0.62));
    const box = renderer.domElement.getBoundingClientRect();
    const dx = box.left + (box.width - width) / 2;
    const dy = box.top + (box.height - height) / 2;
    context.sheetTransform(scale, dx + x * off - (x + dx) * scale, dy + y * off - (y + dy) * scale);
    pageShown(1);
    const halfW = (openW / 2) * scale;
    const halfH = (openH / 2) * scale;
    const left = width / 2 + x * off - halfW;
    const top = height / 2 + y * off - halfH;
    const canvas = renderer.domElement;
    canvas.style.clipPath = `inset(${top}px ${width - left - halfW * 2}px ${height - top - halfH * 2}px ${left}px round ${Math.max(0, radius - border) * scale}px)`;
    canvas.style.opacity = String(smooth(within(t, 0.14, 0.42)));
    // The well's middle is behind the bar's, wherever the bar is on screen.
    camera.setViewOffset(width, height, -x * off, -y * off, width, height);
    setFov(WELL_LENS);
    shapeLot(1, 0);
    if (model) model.root.visible = true;
    through.mesh.visible = false;
    setWell(1, 1);
    stage?.setOcclusion(0);
    return { x: BASE_CENTER.x, y: BASE_CENTER.y, z: GROUND_Z, azimuth: 0, elevation: 0, distance: overWell(Math.min(halfW, width / 2), halfH) };
  }

  /**
   * The bar has gone past the edges of the view, and it is an express run: flat out down the shaft with the lens wide
   * open, the site hidden behind the light at the bottom. Then the brakes, hard, and the
   * structure comes up on arrival.
   */
  function fallDownWell(current: Move, r: number): Pose {
    const { to, through } = current;
    const { width, height } = context.size();
    context.sheetTransform(null);
    const canvas = renderer.domElement;
    canvas.style.removeProperty('clip-path');
    canvas.style.opacity = '1';
    pageShown(0);
    const header = document.querySelector<HTMLElement>('.app-header');
    if (header) header.style.opacity = String(smooth(within(r, 0.72, 1)));
    if (through) through.mesh.visible = false;
    const rise = within(r, WELL_RUN - 0.02, 0.96);
    shapeLot(1, rise > 0 ? backOut(rise) : 0);
    if (model) model.root.visible = true;
    stage?.setOcclusion(within(r, 0.82, 1));
    const high = overWell(width / 2, (height / 2) * 1.03);
    const brakesOn = to.distance * 2.1;
    let distance: number;
    if (r < WELL_RUN) {
      const x = r / WELL_RUN;
      const pickUp = 0.12;
      const speed = 1 / (1 - pickUp / 2);
      distance = lerp(high, brakesOn, x < pickUp ? (speed * x * x) / (2 * pickUp) : speed * (x - pickUp / 2));
    } else {
      distance = to.distance + (brakesOn - to.distance) * (1 - (r - WELL_RUN) / (1 - WELL_RUN)) ** 4;
    }
    const flatOut = smooth(within(r, 0, 0.12)) * (1 - smooth(within(r, WELL_RUN - 0.06, WELL_RUN + 0.06)));
    setWell(1 - smooth(within(r, WELL_RUN - 0.02, 0.8)), smooth(within(distance, 2400, 5200)));
    setFov(lerp(WELL_LENS + 24 * flatOut, FOV, smooth(within(r, 0.74, 1))));
    camera.clearViewOffset();
    const lean = smooth(within(r, 0.78, 1));
    return {
      x: lerp(BASE_CENTER.x, to.x, lean),
      y: lerp(BASE_CENTER.y, to.y, lean),
      z: lerp(GROUND_Z, to.z, lean),
      azimuth: turnTo(0, to.azimuth) * smootherstep(within(r, 0.74, 1)),
      elevation: to.elevation * lean,
      distance,
    };
  }

  /** The shaft: four smooth walls going dark on the way down and bright at the bottom, and the light at the end. */
  function digWell(): void {
    fillWell();
    const wallCanvas = document.createElement('canvas');
    wallCanvas.width = 2;
    wallCanvas.height = 512;
    const wallPaint = wallCanvas.getContext('2d')!;
    const down = wallPaint.createLinearGradient(0, 0, 0, 512);
    down.addColorStop(0, '#aeb9c8');
    down.addColorStop(0.3, '#6c7a8e');
    down.addColorStop(0.8, '#4a586b');
    down.addColorStop(1, `#${new Color(PAPER_COLOR).getHexString()}`);
    wallPaint.fillStyle = down;
    wallPaint.fillRect(0, 0, 2, 512);
    const wallMap = new CanvasTexture(wallCanvas);
    wallMap.colorSpace = SRGBColorSpace;
    const look_ = { transparent: true, depthWrite: false, fog: false, toneMapped: false } as const;
    const walls = new MeshBasicMaterial({ ...look_, map: wallMap, side: DoubleSide });
    const cap = new MeshBasicMaterial({ ...look_, color: PAPER_COLOR });
    const group = new Group();
    group.position.set(BASE_CENTER.x, BASE_CENTER.y, GROUND_Z);
    const { w, d } = BASE_SIZE;
    const geometries: PlaneGeometry[] = [];
    const place_ = (geometry: PlaneGeometry, material: MeshBasicMaterial, x: number, y: number, z: number, order: number) => {
      if (!geometries.includes(geometry)) geometries.push(geometry);
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.renderOrder = order;
      group.add(mesh);
    };
    const across = new PlaneGeometry(w, WELL_DEPTH).rotateX(Math.PI / 2);
    const along = new PlaneGeometry(d, WELL_DEPTH).rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
    for (const side of [-1, 1]) {
      place_(across, walls, 0, (side * d) / 2, WELL_DEPTH / 2, 59);
      place_(along, walls, (side * w) / 2, 0, WELL_DEPTH / 2, 59);
    }
    place_(new PlaneGeometry(w, d), cap, 0, 0, 70, 58);
    scene.add(group);
    well = { group, maps: [wallMap], walls, cap, geometries };
  }

  function setWell(walls: number, cap: number): void {
    if (!well) return;
    well.group.visible = walls > 0.004 || cap > 0.004;
    well.walls.opacity = walls;
    well.cap.opacity = cap;
  }

  function fillWell(): void {
    if (!well) return;
    scene.remove(well.group);
    for (const geometry of well.geometries) geometry.dispose();
    well.walls.dispose();
    well.cap.dispose();
    for (const map of well.maps) map.dispose();
    well = null;
  }

  /** In with no bar to go through: the lot spreads out on the plan and the site springs up out of it. */
  function glideIn(current: Move): Pose {
    const u = current.t;
    // The bar lifts off the plan, grows flat into the lot, and the site springs up out of it.
    const lifting = easeOut(within(u, 0, 0.14));
    const spread = smootherstep(within(u, 0.12, 0.5));
    const rise = within(u, 0.44, 0.9);
    const standing = rise > 0 ? backOut(rise) : 0;
    shapeLot(spread, standing);
    if (model) model.root.visible = u >= 0.12;
    const block = current.through;
    if (block) {
      // It keeps its own size and face, lifted over the lot as the lot spreads out from under it, and fades.
      const top = GROUND_Z * (1 - lerp(FLAT, 1, standing));
      const grow = 1 + 0.05 * lifting;
      block.mesh.position.set(0, 0, top + BLOCK_DEPTH / 2 + 0.6 + lifting * 16);
      block.mesh.scale.set(seed.w * grow, seed.d * grow, BLOCK_DEPTH);
      const shown = 1 - smooth(within(u, 0.2, 0.36));
      block.face.opacity = shown;
      block.side.opacity = shown;
      block.mesh.visible = shown > 0.01;
    }
    stage?.setOcclusion(within(u, 0.84, 1));
    // The camera dives toward the bar, which stays where it is on screen as it grows, then leans over into the view.
    const from = current.from;
    const to = current.to;
    const zoom = easeInOut(within(u, 0.04, 1));
    const distance = Math.exp(lerp(Math.log(from.distance), Math.log(to.distance), zoom));
    const held = distance / from.distance;
    const arrive = smootherstep(within(u, 0.28, 1));
    return {
      x: lerp(from.x * held, to.x, arrive),
      y: lerp(from.y * held, to.y, arrive),
      z: lerp(GROUND_Z, to.z, arrive),
      azimuth: from.azimuth + turnTo(from.azimuth, to.azimuth) * smootherstep(within(u, 0.22, 1)),
      elevation: to.elevation * smootherstep(within(u, 0.16, 0.94)),
      distance,
    };
  }

  function runReturn(current: Move): Pose {
    const u = current.t;
    // The pieces fly back to their bars, the highest first; each is gone from the building as its block sets off.
    for (const block of current.blocks) {
      const k = 1 - within(u, block.delay, block.delay + block.span);
      block.mesh.visible = k < 0.995;
      placeBlock(block, k);
    }
    const gone = [...current.at].filter(([, at]) => at <= u).map(([id]) => id);
    if (gone.length !== (hiddenNow?.size ?? -1)) {
      hiddenNow = new Set(gone);
      paint();
    }
    // Then the lot sinks into the plan and draws back into the bar it came out of.
    const sink = smoothIn(within(u, 0.44, 0.66));
    const gather = smootherstep(within(u, 0.6, 0.86));
    shapeLot(1 - gather, 1 - sink);
    if (model) model.root.visible = u < 0.86;
    if (u >= 0.86 && cameThrough !== null) liftGroundBar(cameThrough, false);
    stage?.setOcclusion(1 - within(u, 0, 0.16));
    // The page's chrome comes back over the plan's bars.
    if (u > 0.84) pageShown(1);
    renderer.domElement.style.opacity = String(1 - smooth(within(u, 0.9, 1)));
    // The camera rises back over the chart: toward the bar, then out until the chart is where it was.
    const from = current.from;
    const rest = current.to;
    const zoom = easeInOut(within(u, 0.06, 0.94));
    const distance = Math.exp(lerp(Math.log(from.distance), Math.log(rest.distance), zoom));
    const held = distance / rest.distance;
    const leave = smootherstep(within(u, 0.04, 0.62));
    return {
      x: lerp(from.x, rest.x * held, leave),
      y: lerp(from.y, rest.y * held, leave),
      z: lerp(from.z, rest.z, leave),
      azimuth: from.azimuth + turnTo(from.azimuth, rest.azimuth) * smootherstep(within(u, 0.06, 0.84)),
      elevation: from.elevation * (1 - smootherstep(within(u, 0.1, 0.86))),
      distance,
    };
  }

  function update(dt: number, time: number): Pose | null {
    const pose = updateScene(dt, time);
    if (pose) lastPose = pose;
    return pose;
  }

  function updateScene(dt: number, time: number): Pose | null {
    if (!live || !model || !plan) return null;
    if (playing) {
      // The crane's rental takes its days at its own pace, after a moment on the first.
      const telling = story?.playing === true;
      const held = telling && performance.now() < story!.holdUntil;
      const next = held ? date : date + (dt / (telling ? storyPace() : playPace)) * DAY_MS;
      const stop = playUntil ?? plan.span[1];
      if (next >= stop) {
        setDate(stop);
        stopPlaying();
        if (telling) storyPlayed();
      } else if (next !== date) setDate(next);
    }
    // Apart, lifted, open: each eases toward where it was asked to be.
    const liftTarget = focus !== null ? 1 : 0;
    const before = apart + lift * 10 + cutaway * 100;
    apart = damp(apart, apartTarget, 5, dt);
    lift = damp(lift, liftTarget, 5, dt);
    cutaway = damp(cutaway, cutawayTarget, 6, dt);
    if (Math.abs(apart + lift * 10 + cutaway * 100 - before) > 1e-4) {
      model.setOffsets(offsets());
      model.setCutaway(cutaway);
      // Apart, the ground over the footings turns to glass, so the foundations show as a layer of their own.
      model.site.setReveal(Math.min(1, apart * 1.25));
    }
    runDusk(dt);
    model.update(dt, time);
    if (calendar) {
      calendar.track.group.visible = calendarShown();
      if (calendar.morph < 1) {
        calendar.morph = Math.min(1, calendar.morph + dt / (story ? FOLD_SECONDS : 1.8));
        calendar.track.morph(calendar.morph);
      }
      if (story?.emphasis && story.shown < 1) {
        story.shown = Math.min(1, story.shown + dt / 0.45);
        calendar.track.emphasize(story.emphasis, smooth(story.shown));
      }
      calendar.track.update(story?.circling || story?.holding ? plan.span[1] : date);
    }
    if (story?.change && !story.changeShown && performance.now() >= story.changeAt) showChange();
    if (move) return runMove(dt);
    if (dolly) {
      dolly.t = Math.min(1, dolly.t + dt / dolly.seconds);
      const fov = lerp(dolly.fromFov, dolly.toFov, smootherstep(dolly.t));
      setFov(fov);
      // The camera closes in as the lens opens, by just what keeps what it looks at the same size.
      const pose = { ...dolly.from, distance: (dolly.from.distance * halfTan(dolly.fromFov)) / halfTan(fov) };
      if (dolly.t >= 1) {
        const done = dolly;
        dolly = null;
        done.after(pose);
      }
      return pose;
    }
    // Off the crane when it goes off site (the date moved past its rental): back down to what was on show.
    if (ride && !model.craneHook(hookPoint)) rideCrane(false);
    if (ride) {
      ride.t += dt;
      // Up in about a second, then still on the jib but for the wind turning it a little about the mast.
      return mixPose(ride.from, turnPose(ride.to, ride.mast, jibSway(time)), ease(within(ride.t, 0, context.reducedMotion ? 0.01 : MOVE_SECONDS)));
    }
    if (orbit && !glide) {
      orbit.t = Math.min(1, orbit.t + dt / orbit.seconds);
      // Eased in and out, so it sets off and comes to rest like a camera on a crane would.
      const turned = orbit.t * orbit.t * (3 - 2 * orbit.t);
      const azimuth = orbit.from.azimuth + turned * orbit.turn;
      // Higher over the tall neighbors behind the site, lower over the street (building-site.ts).
      orbit.last = aroundPose(orbit.center, azimuth, flyLean(azimuth) + orbit.lean, orbit.from.distance, orbit.middle, orbit.lens);
      if (orbit.t >= 1) {
        stopOrbit();
        return null;
      }
      return orbit.last;
    }
    if (glide) {
      glide.t = Math.min(1, glide.t + dt / glide.seconds);
      if (glide.fromFov !== undefined && glide.toFov !== undefined) setFov(lerp(glide.fromFov, glide.toFov, ease(glide.t)));
      const pose = mixPose(glide.from, glide.to, ease(glide.t));
      if (glide.t >= 1) {
        const done = glide;
        glide = null;
        context.handToControls(done.to, undefined, done.to.distance * 1.6);
        done.after?.();
        return null;
      }
      return pose;
    }
    return null;
  }

  /** What the callout keeps clear of, in the labels' own pixels; looked up a few times a second, not every frame. */
  let blockers: { left: number; top: number; right: number; bottom: number }[] = [];
  let blockersAt = 0;
  /** Where the floors begin, from the left: the card stays left of them, whatever height it ends up at. */
  let floorsLeft = Infinity;

  /**
   * The callout over its piece, pointing down at it; under the piece instead, pointing up, when over it would cover the
   * readout, a note, the floors, the controls or the walkthrough's call; failing both, just under what is in its way.
   */
  function placeCallout(at: { x: number; y: number }, width: number, height: number, now: number): void {
    if (now - blockersAt > 240) {
      blockersAt = now;
      const origin = labels.getBoundingClientRect();
      const call = document.querySelector<HTMLElement>('[data-testid="rail-call"]');
      blockers = [readout, toast, floors, bar, legend, closeButton, focusChip, call]
        .filter((element): element is HTMLElement => element instanceof HTMLElement && !element.hidden && element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
        });
      floorsLeft = floors.getClientRects().length > 0 ? floors.getBoundingClientRect().left - origin.left : Infinity;
    }
    const w = callout.offsetWidth;
    const h = callout.offsetHeight;
    const EDGE = 10;
    const GAP = 14;
    const right = Math.min(width, floorsLeft) - EDGE;
    const x = Math.max(w / 2 + EDGE, Math.min(right - w / 2, at.x));
    const boxAt = (top: number) => ({ left: x - w / 2, right: x + w / 2, top, bottom: top + h });
    const clear = (box: { left: number; right: number; top: number; bottom: number }) =>
      box.top >= EDGE && box.bottom <= height - EDGE && !blockers.some((b) => b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top);
    const above = boxAt(at.y - GAP - h);
    const below = boxAt(at.y + GAP);
    let place = clear(above) ? above : clear(below) ? below : null;
    if (!place) {
      const inTheWay = blockers.filter((b) => b.left < above.right && b.right > above.left && b.bottom < height / 2).map((b) => b.bottom + 8);
      place = boxAt(Math.max(EDGE, Math.min(Math.max(EDGE, ...inTheWay), height - h - EDGE)));
    }
    // In a short view the card can only go where the readout is: the readout steps aside while the card is up.
    const origin = labels.getBoundingClientRect();
    const read = readout.getBoundingClientRect();
    const covered = read.width > 0 && read.left - origin.left < place.right && read.right - origin.left > place.left && read.top - origin.top < place.bottom && read.bottom - origin.top > place.top;
    readout.classList.toggle('is-covered', covered);
    const under = place.top > at.y;
    callout.classList.toggle('is-below', under);
    // The arrow stays on the piece while the card is held inside the view; it goes when the piece is not beside it.
    const arrow = at.x - place.left;
    callout.classList.toggle('is-adrift', arrow < 14 || arrow > w - 14 || (under ? place.top - at.y > GAP + 4 : at.y - place.bottom > GAP + 4));
    callout.style.setProperty('--arrow-x', `${Math.round(Math.min(w - 14, Math.max(14, arrow)))}px`);
    callout.style.transform = `translate(${Math.round(place.left)}px, ${Math.round(place.top)}px)`;
  }

  function afterCamera(): void {
    if (!live || !model || !plan) return;
    const { width, height } = context.size();
    const project = (at: Vector3) => {
      point.copy(at).project(camera);
      return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height, behind: point.z > 1 };
    };
    const settled = !move;
    // The plan's rows say what each is doing on the date, a few times a second.
    const now = performance.now();
    makeRoom(now);
    if (now - rowsAt > 220 && !document.documentElement.classList.contains('fxb-full')) {
      rowsAt = now;
      markRows();
    }
    // The callout over what is chosen.
    if (selected && !callout.hidden && settled) {
      const box = boxOf(selected) ?? (focus !== null ? layerBox(focus) : null) ?? model.siteBounds(new Box3());
      if (box) {
        const top = box.getCenter(new Vector3());
        top.z = box.max.z + 6;
        placeCallout(project(top), width, height, now);
      }
    } else if (readout.classList.contains('is-covered')) readout.classList.remove('is-covered');
    // Each layer's name beside it while the building is apart.
    const tagsShown = apart > 0.35 && settled;
    layerTags.classList.toggle('is-shown', tagsShown);
    if (tagsShown) {
      for (const tag of layerTags.children as HTMLCollectionOf<HTMLElement>) {
        const index = Number(tag.dataset.layer);
        const range = model.layerSpan(index);
        const at = project(new Vector3(-158, -104, range.z + Math.min(range.height, 40) * 0.35 + model.offsetOf(index)));
        tag.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
        tag.classList.toggle('is-focus', focus === index);
        tag.hidden = at.behind || at.y < 60 || at.y > height - 80;
      }
    }
    // The calendar's name and what it adds up to, over its top left corner.
    if (calendar && calendar.track.group.visible && plan) {
      const booking = plan.bookings.find((entry) => entry.task.id === calendar!.taskId);
      const site = sites.get(calendar.taskId);
      const at = project(new Vector3(CALENDAR_AT.x - calendar.track.width / 2, CALENDAR_AT.y + calendar.track.depth / 2 + 4, 8));
      if (booking && site) writeCalendarTag(booking, site);
      if (story) {
        // Told for the film, the tag sits under the calendar as seen, wherever the camera has gone round to.
        const [hw, hd] = [calendar.track.width / 2, calendar.track.depth / 2];
        const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => project(new Vector3(CALENDAR_AT.x + sx * hw, CALENDAR_AT.y + sy * hd, 6))));
        const below = Math.max(...corners.map((corner) => corner.y));
        const above = Math.min(...corners.map((corner) => corner.y));
        const middleX = corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length;
        // Under the calendar while it fits above the call, else over it.
        if (tagHeightKey !== tagKey) {
          tagHeightKey = tagKey;
          tagHeight = calendarTag.offsetHeight || tagHeight;
        }
        const floor = Math.min(height, callTop - viewTop) - 16;
        // Held on the calendar it always goes under it: the frame leaves the room, and it never drops out of the shot.
        const held = story.holding;
        const under = held || below + 10 + tagHeight <= floor;
        calendarTag.classList.add('is-under');
        calendarTag.classList.toggle('is-over', !under);
        calendarTag.hidden = corners.some((corner) => corner.behind) || middleX < 0 || middleX > width || (!under && above - 10 - tagHeight < 8);
        calendarTag.style.transform = `translate(${Math.round(Math.min(width - 170, Math.max(170, middleX)))}px, ${Math.round(held ? Math.min(below, floor - 10 - tagHeight) : under ? below : above)}px)`;
      } else {
        calendarTag.classList.remove('is-under');
        calendarTag.hidden = at.behind || at.y < 70 || at.y > height - 80;
        calendarTag.style.transform = `translate(${Math.round(Math.max(8, at.x))}px, ${Math.round(at.y)}px)`;
      }
    } else calendarTag.hidden = true;
    // What is under way on the date, named where it stands, unless something is chosen or the building is apart.
    const quiet = !settled || Boolean(selected) || apart > 0.35 || focus !== null || Boolean(story);
    const under = quiet ? [] : tasks.filter((task) => !task.milestone && date >= task.start && date < task.end && builtBy(task, date) > 0).slice(0, 3);
    while (nowTags.children.length < under.length) {
      const tag = document.createElement('div');
      tag.className = 'fxb-now-tag';
      tag.append(document.createElement('strong'), document.createElement('span'));
      nowTags.append(tag);
    }
    [...(nowTags.children as HTMLCollectionOf<HTMLElement>)].forEach((tag, index) => {
      const task = under[index];
      const box = task ? boxOf([task.id]) : null;
      if (!task || !box) {
        tag.hidden = true;
        return;
      }
      const top = box.getCenter(new Vector3());
      top.z = box.max.z + 4;
      const at = project(top);
      const day = task.workDays.filter((each) => each <= date).length;
      tag.querySelector('strong')!.textContent = task.name;
      tag.querySelector('span')!.textContent = `${datesOf(task)} · day ${Math.max(1, day)} of ${task.workDays.length}`;
      tag.hidden = at.behind || at.y < 90 || at.y > height - 90;
      tag.style.transform = `translate(${Math.round(Math.min(width - 120, Math.max(120, at.x)))}px, ${Math.round(at.y - index * 4)}px)`;
    });
    placeHoldTags(settled, width, height, project);
    // An idle machine says so, beside it. While its rental is told: IDLE over the crane, on each day it has nothing to lift.
    const crane = plan.bookings.find((booking) => booking.machine.kind === 'crane');
    const on = crane ? machineOn(crane, date) : null;
    if (story && !story.circling && !story.holding && on?.idle && settled && !ride) {
      const reach = model.craneBounds(bounds);
      const at = project(new Vector3(CRANE_AT.x, CRANE_AT.y, reach ? reach.max.z * 0.7 : 160));
      idleTag.hidden = at.behind || at.x < 40 || at.x > width - 40 || at.y < 70 || at.y > height - 90;
      idleTag.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    } else idleTag.hidden = true;
    if (crane && on?.idle && settled && !story && calendarTag.hidden && !document.documentElement.classList.contains('fxb-full')) {
      const at = project(new Vector3(CRANE_AT.x, CRANE_AT.y, 120));
      const idle = idleBy(crane, plan.span[1]);
      machineTag.hidden = at.behind || at.x < 0 || at.x > width - 40 || at.y < 70 || at.y > height - 90;
      machineTag.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      const rate = crane.machine.rateMinor;
      machineTag.textContent = rate > 0 ? `${crane.machine.name} on rent, nothing to lift · ${money(rate)} a day · ${idle.days} idle days, ${money(idle.costMinor)}` : `${crane.machine.name} on rent, nothing to lift`;
    } else machineTag.hidden = true;
  }

  function render(): boolean {
    if (!live || !stage) return false;
    stage.render();
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // The pointer, over the canvas (in the canvas's own pixels)
  // ---------------------------------------------------------------------------------------

  function pickAt(x: number, y: number): { taskId: number; layer: number } | null {
    if (!model) return null;
    const { width, height } = context.size();
    pointer.set((x / width) * 2 - 1, 1 - (y / height) * 2);
    camera.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
    return model.pick(ray);
  }

  /** The day under the pointer on the crane's strip, if the strip is there. */
  function tileAt(x: number, y: number): DayTile | null {
    if (!calendar || !calendar.track.group.visible) return null;
    const { width, height } = context.size();
    pointer.set((x / width) * 2 - 1, 1 - (y / height) * 2);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(calendar.track.face, false)[0];
    return hit?.uv ? calendar.track.tileAtUv(hit.uv.x, hit.uv.y) : null;
  }

  function hover(x: number, y: number): void {
    if (!live || move || glide || ride) return;
    const tile = tileAt(x, y);
    if (calendar) {
      const at = tile?.at ?? null;
      if (calendar.hovered?.at !== at) {
        calendar.hovered = tile;
        calendar.track.setHover(at);
      }
    }
    if (tile && calendar && plan) {
      const booking = plan.bookings.find((entry) => entry.task.id === calendar!.taskId);
      hoverTip.replaceChildren();
      const words = document.createElement('strong');
      const days = sites.get(calendar.taskId)?.days ?? [];
      // The calendar runs whole weeks: a day around the rental is simply not on rent.
      words.textContent = days.some((day) => day.at === tile.at)
        ? dayWords(tile, days, booking?.machine.name ?? null, money)
        : `${new Date(tile.at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: ${booking?.machine.name ?? 'The machine'} not on rent`;
      const hint = document.createElement('span');
      hint.textContent = 'Click to see the site on this day';
      hoverTip.append(words, hint);
      hoverTip.hidden = false;
      const { width } = context.size();
      hoverTip.style.transform = `translate(${Math.round(Math.min(width - 260, x + 16))}px, ${Math.round(y + 18)}px)`;
      renderer.domElement.style.cursor = 'pointer';
      if (hovered !== null) {
        hovered = null;
        paint();
      }
      return;
    }
    const hit = pickAt(x, y);
    const next = hit && records.has(hit.taskId) ? hit.taskId : null;
    renderer.domElement.style.cursor = next !== null ? 'pointer' : '';
    // What the pointer is on, in words, beside it: the same row lights up in the plan.
    const task = next !== null ? tasks.find((entry) => entry.id === next) : null;
    if (task) {
      hoverTip.replaceChildren();
      const name = document.createElement('strong');
      name.textContent = task.name;
      const when = document.createElement('span');
      when.textContent = `${datesOf(task)}${task.crews[0] ? ` · ${task.crews[0].name}` : ''}`;
      const state = document.createElement('span');
      state.className = 'fxb-hovertip-state';
      state.textContent = stateWords(task);
      hoverTip.append(name, when, state);
      hoverTip.hidden = false;
      const { width } = context.size();
      hoverTip.style.transform = `translate(${Math.round(Math.min(width - 260, x + 16))}px, ${Math.round(y + 18)}px)`;
    } else hoverTip.hidden = true;
    if (next === hovered) return;
    hovered = next;
    paint();
    rowsAt = 0;
    context.wake();
  }

  function click(x: number, y: number): void {
    if (!live || move) return;
    const tile = tileAt(x, y);
    if (tile) {
      stopPlaying();
      setDate(tile.at + DAY_MS / 2);
      return;
    }
    const hit = pickAt(x, y);
    if (!hit || !records.has(hit.taskId)) {
      if (selected) {
        clearSelection();
        deselectRows();
      }
      return;
    }
    const record = records.get(hit.taskId)!;
    picking = true;
    try {
      context.selectTask(record);
      (gantt as unknown as { scrollRowIntoView?(record: TaskModel, options?: object): unknown }).scrollRowIntoView?.(record, { block: 'nearest', animate: true });
    } finally {
      picking = false;
    }
    choose(record);
  }

  function doubleClick(x: number, y: number): void {
    if (move) return;
    const hit = pickAt(x, y);
    const record = hit ? records.get(hit.taskId) : null;
    if (record) context.editTask(record);
  }

  // ---------------------------------------------------------------------------------------
  // The plan changed: follow it, and say what a new rental date saved
  // ---------------------------------------------------------------------------------------

  function idleTotals(): Map<number, number> {
    const totals = new Map<number, number>();
    for (const booking of plan?.bookings ?? []) totals.set(booking.task.id, idleBy(booking, Number.MAX_SAFE_INTEGER).costMinor);
    return totals;
  }

  function planChanged(): void {
    if (!live || leaving) return;
    if (move) {
      // After the way in: the building is built again from the plan as it stands then.
      wanted = wanted ?? [];
      return;
    }
    const was = tasks;
    const craneBefore = craneRental()?.site.days ?? null;
    const next = read();
    if (!next) {
      close();
      return;
    }
    const nextShape = shapeOf(tasks);
    if (nextShape !== shape) {
      shape = nextShape;
      // Only a machine's dates moved: the building is the same, so it takes the new dates as it stands (a rebuild would
      // stall the frames the camera is moving through).
      if (model && shapeOf(was, false) === shapeOf(tasks, false)) rebook(next);
      else build(next);
      setDate(date);
    } else {
      plan = next;
      writeFloorStates();
      if (selected) writeCallout();
    }
    paint();
    layGround();
    if (cameThrough !== null) liftGroundBar(cameThrough, true);
    // While the crane's rental is told, its new dates fold the old days away on the calendar where it is, and what they
    // saved shows on it once they have. Held on the calendar or circling the site for the film, the camera goes on with
    // what it was doing and nothing else comes up; otherwise the view goes to the calendar with a note, as for any new dates.
    const craneAfter = craneRental();
    const change = craneBefore && craneAfter ? rentalChange(craneBefore, craneAfter.site.days, craneAfter.booking.machine.rateMinor) : null;
    if (story && change) {
      story.change = change;
      story.changeShown = false;
      story.changeAt = performance.now() + (context.reducedMotion ? 0 : FOLD_SECONDS * 1000);
      tagKey = '';
      if (story.circling || story.holding) {
        lastIdle = idleTotals();
        attendBox(calendarBox());
        // On the calendar: what stays comes up as the idle days fold away, not after.
        if (story.holding) emphasizeDays('span');
        return;
      }
    }
    // A rental's new dates: the idle days it no longer pays for.
    const before = lastIdle;
    lastIdle = idleTotals();
    for (const booking of next.bookings) {
      const was = before.get(booking.task.id) ?? 0;
      const now = lastIdle.get(booking.task.id) ?? 0;
      if (was > now && look().canViewCosts) {
        const record = records.get(booking.task.id);
        const saved = was - now;
        setDate(midday(booking.machine.booked[0]));
        lookAtCalendar();
        showToast(`${booking.machine.name}: ${money(saved)} less on rent, booked for the days it works.`, record && context.openPayment ? { label: 'Go to the payment', run: () => context.openPayment?.(record) } : undefined);
        break;
      }
    }
  }

  function show(taskIds: readonly number[]): void {
    // Held on the calendar for a change of dates: applying it shows its task, and the camera stays.
    if (!live || story?.holding) return;
    const list = taskIds.map((id) => records.get(id)).filter((record): record is TaskModel => Boolean(record));
    if (move || list.length === 0) {
      wanted = taskIds;
      return;
    }
    if (list.length === 1) {
      const target = tasks.find((task) => task.id === (list[0]!.id as number));
      if (target && (date < target.start || date >= target.end)) setDate(midday(target.machine && target.machine.booked[0] < target.start ? target.machine.booked[0] : target.start));
      choose(list[0]!);
      return;
    }
    selected = new Set(list.map((record) => record.id as number));
    ghostSelection = true;
    shownWith = companionsOf([...selected]);
    cutawayTarget = 1;
    paint();
    writeCallout();
    attendBox(boxOf(selected));
    const pose = posePiece([...selected]);
    if (pose) glideTo(pose);
  }

  /** One step back: a choice, a floor, taken apart, then the chart. */
  function up(): void {
    if (!live || move) return;
    if (ride) {
      rideCrane(false);
      return;
    }
    if (selected) {
      clearSelection();
      deselectRows();
      glideTo(focus !== null ? storyPose(focus) : heroPose());
      return;
    }
    if (focus !== null) {
      setFocus(null);
      glideTo(heroPose());
      return;
    }
    if (apartTarget > 0.5) {
      setApart(0);
      return;
    }
    close();
  }

  let warming = false;
  /** When the warm-up finished, in ms since the page loaded, for checking it by hand. */
  let warmedAt: number | null = null;
  /** Far enough away to take in the whole lot. */
  const WARM_POSE: Pose = { x: 0, y: -40, z: 120, azimuth: -0.6, elevation: 1.0, distance: 2400 };
  /**
   * Ahead of the first visit, while nothing else is going on: the building is built (out of sight), every material
   * it has or can be painted with is compiled in parallel, and then it is drawn once through every pass at a few
   * dates (a pour, the steel going up, the crane idle, the handover) into the stage's own buffers, so that shadows,
   * people, machines and the passes have their shaders too. It is only ever visible inside those draws, which never
   * reach the screen, and it stops as soon as the view opens, leaving the view as the visit set it.
   */
  async function warm(): Promise<void> {
    if (live || model || warming) return;
    warming = true;
    const idle = () => new Promise<void>((resolve) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 200)));
    const culled: Object3D[] = [];
    try {
      const next = read();
      if (!next) return;
      await Promise.race([context.workersReady, new Promise((resolve) => setTimeout(resolve, 2500))]);
      await idle();
      if (live || model) return;
      shape = shapeOf(tasks);
      date = midday(next.span[0]);
      // The canvas takes the view's size now, so the first visit doesn't have to.
      host.setInset(insetRect());
      stage = createStage(renderer, scene, camera, host.lights);
      build(next);
      dropCalendar();
      const built = model as BuildingModel | null;
      if (!built) return;
      built.root.visible = false;
      // Nothing is left out for being off camera.
      built.root.traverse((object) => {
        if (object.frustumCulled) {
          object.frustumCulled = false;
          culled.push(object);
        }
      });
      // A bar's block, as the way in lifts it out of the plan and fades it.
      const sampleFace = new CanvasTexture(document.createElement('canvas'));
      const sample = new Mesh(blockGeometry, [new MeshBasicMaterial({ color: '#8a96a3', transparent: true }), new MeshBasicMaterial({ map: sampleFace, transparent: true })]);
      sample.visible = false;
      scene.add(sample);
      const paints: PaintRule[] = [{}, { keep: () => false }, { tint: () => '#0070e0' }, { hover: tasks[0]?.id ?? null }];
      for (const rule of paints) {
        built.setPaint(rule);
        await renderer.compileAsync(scene, camera);
        if (live) return;
      }
      built.setPaint({});
      // The plan's ground and a bar's block are drawn with the site, so their shadows and shading are ready too. The bar
      // is shown only inside each draw below: between them, a frame of the chart could otherwise catch it.
      groundBars.setMatrixAt(0, placing.compose(new Vector3(0, -300, GROUND_Z + 0.5), level, sized.set(300, 40, 1)));
      groundBars.instanceMatrix.needsUpdate = true;
      sample.position.set(0, -300, GROUND_Z + 10);
      sample.scale.set(300, 40, BLOCK_DEPTH);
      sample.castShadow = true;
      const pour = next.parts.find((part) => part.kind === 'pour');
      const steel = next.parts.find((part) => part.kind === 'steel');
      const crane = next.bookings.find((booking) => booking.machine.kind === 'crane');
      const dates = [pour?.task.start, steel?.task.start, crane?.machine.booked[0], next.span[1] - DAY_MS].filter((at): at is number => typeof at === 'number');
      for (const at of dates) {
        await idle();
        if (live) return;
        built.setDate(midday(at));
        built.update(0.016, 0);
        placeCamera(camera, WARM_POSE);
        built.root.visible = true;
        ground.visible = true;
        sample.visible = true;
        groundBars.count = 1;
        stage.warm();
        built.root.visible = false;
        ground.visible = false;
        sample.visible = false;
        groundBars.count = 0;
      }
      sample.removeFromParent();
      sampleFace.dispose();
      for (const material of sample.material as MeshBasicMaterial[]) material.dispose();
      groundBars.count = 0;
      warmedAt = Math.round(performance.now());
    } catch (error) {
      console.warn('The site view could not be made ready ahead of time', error);
    } finally {
      for (const object of culled) object.frustumCulled = true;
      // The lights go back to the chart's, unless a visit has begun meanwhile and dressed them for itself.
      if (!live) stage?.restore();
      warming = false;
      // One clean frame: the canvas over the chart keeps whatever was drawn last.
      if (!live) context.wake();
    }
  }

  return {
    fits: () => read() !== null,
    warm,
    isOpen: () => live,
    open,
    close,
    up,
    lastWork: () => null,
    update,
    afterCamera,
    hover,
    click,
    doubleClick,
    resized: () => {
      if (live) place();
    },
    planChanged,
    show,
    // Remy's face comes out once the view is up, not while the bars are still flying in or the camera still falling.
    settled: () => live && !leaving && !move,
    // What the crane's two buttons do, for Remy: its days on the lot, or up on it and back down.
    // What the play button, the date rail and the floors list do, for Remy.
    control: {
      state: () => ({ day: plan ? isoOf(date) : null, playing, riding: Boolean(ride), level: focus !== null ? (plan?.layers[focus]?.name ?? null) : null }),
      levels: () => (plan?.layers ?? []).map((layer) => ({ name: layer.name, short: layer.short })),
      span: () => (plan ? plan.span : null),
      play(from, to, seconds) {
        if (!live || leaving || move || !plan) return false;
        const [first, last] = plan.span;
        const start = Math.min(last, Math.max(first, from ?? date));
        const stop = Math.min(last, Math.max(first, to ?? last));
        if (stop <= start) return false;
        if (ride) rideCrane(false);
        stopPlaying();
        const days = Math.max(1, Math.round((stop - start) / DAY_MS));
        // About as long as asked: a span of weeks in a few seconds, never a blur, never a crawl.
        playPace = seconds ? Math.min(0.9, Math.max(SECONDS_PER_DAY / 2, seconds / days)) : SECONDS_PER_DAY;
        playUntil = stop;
        setDate(start);
        playing = true;
        playButton.classList.add('is-playing');
        playButton.setAttribute('aria-label', 'Pause');
        context.wake();
        return true;
      },
      pause: () => stopPlaying(),
      goTo(day) {
        if (!live || leaving || !plan) return false;
        stopPlaying();
        setDate(midday(day));
        return true;
      },
      level(name) {
        if (!live || leaving || move || !plan) return false;
        if (name === null) {
          setFocus(null);
          glideTo(heroPose());
          return true;
        }
        const wanted = name.trim().toLowerCase();
        const layer = plan.layers.find((each) => each.name.toLowerCase() === wanted || each.short.toLowerCase() === wanted) ?? plan.layers.find((each) => each.name.toLowerCase().includes(wanted));
        if (!layer) return false;
        if (ride) rideCrane(false);
        selected = null;
        callout.hidden = true;
        deselectRows();
        setFocus(layer.index);
        glideTo(storyPose(layer.index));
        return true;
      },
    },
    crane(look) {
      if (!live || leaving || move) return false;
      if (look === 'days') {
        if (!calendar || daysButton.hidden) return false;
        stopPlaying();
        lookAtCalendar();
        return true;
      }
      if (look === 'down') {
        rideCrane(false);
        return !ride;
      }
      if (rideButton.hidden) return false;
      rideCrane(true);
      return Boolean(ride);
    },
    panelChanged: () => {
      if (!live) return;
      // The controls make way for the panel as it slides in, and take the width back as it goes.
      makeRoom(performance.now(), true);
      window.setTimeout(() => {
        if (!live) return;
        place();
        makeRoom(performance.now(), true);
      }, 260);
    },
    render,
    quality(level) {
      quality = level >= 2 ? 2 : level >= 1 ? 1 : 0;
      stage?.setQuality(quality);
    },
    destroy() {
      if (live) finish();
      model?.dispose();
      model = null;
      stage?.dispose();
      stage = null;
      renderer.domElement.removeEventListener('pointerdown', takeOver, { capture: true });
      renderer.domElement.removeEventListener('wheel', takeOver, { capture: true });
      overlay.remove();
      ground.removeFromParent();
      groundBars.dispose();
      groundPaper.geometry.dispose();
      groundShade.geometry.dispose();
      blockGeometry.dispose();
      window.clearTimeout(idleTimer);
      window.clearTimeout(toastTimer);
    },
  };
}
