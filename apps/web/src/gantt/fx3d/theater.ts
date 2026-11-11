/**
 * The 3D layer over the chart: one transparent WebGL canvas (a page gets about 16 contexts, so never one per
 * bar) whose camera starts exactly over the page, so a bar can leave the chart from where it was drawn. The
 * chart itself stays flat and fades away behind the scene. The canvas takes no pointer events and draws
 * nothing until the site opens, and its loop stops when nothing is moving. What happens on it is in
 * site-view.ts; this file owns the renderer, the light and the camera controls.
 */
import type { TaskModel } from '@bryntum/gantt';
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MOUSE,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  type Texture,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import '../../styles/fx3d.css';
import type { Theater, TheaterOptions } from './index';
import { cssColor, disposeDeep, paintFace, tokenColor } from './page';
import { createMaterials } from './parts';
import { loadWorkers, type WorkerKit } from './people';
import { loadProps, PROP_NAMES, type PropKit } from './props';
import { createSidePanel } from './side-panel';
import { FOV, placeCamera, type Pose, poseOfCamera, restPose } from './rig';
import { createBuildingView } from './building-view';
import { createCompanion } from './companion';
import { createSiteView, type SiteContext, type SiteView } from './site-view';
import { loadPin, type SignPart } from './standing-models';
import { createBackdrop, PAPER } from './paper';
import { createViewPad, type OrbitStep, steppedOffset, wheelAction, type WheelGesture } from './view-pad';

/** How sharp to draw at each step down; one step past the end, shadows also stop moving. */
const PIXEL_RATIOS = [2, 1.5, 1, 0.75];
const QUALITY_FLOOR_FPS = 40;

export function createTheater({ gantt, look, editTask, openFix, showPanelTab, hasAssistant, selectTask }: TheaterOptions): Theater {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return { planChanged: () => {}, show: () => {}, destroy: () => {} }; // No WebGL here: the chart simply stays as it is.
  }
  const page = document.getElementById('root')!;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const materials = createMaterials();
  let workerKit: WorkerKit | null = null;
  let propKit: PropKit | null = null;
  const workersReady = Promise.all([
    loadWorkers().then((kit) => {
      workerKit = kit;
    }),
    loadProps().then((kit) => {
      propKit = kit;
    }),
  ]);
  let pin: SignPart[] | null = null;
  void loadPin(cssColor(tokenColor('--ink'))).then((parts) => {
    pin = parts;
  });

  // Everything a first visit will need, made ready while nothing else is going on: shaders take a moment to compile,
  // and that moment should not be the one after someone has asked to go in.
  void workersReady.then(() => {
    const warm = (): void => {
      if (live) return;
      // Hidden the whole time: three compiles hidden meshes too (it walks every object, not only the visible ones),
      // and a frame drawn while the shaders compile would otherwise leave the shelf on the canvas over the chart.
      const shelf = new Group();
      shelf.visible = false;
      const textures: Texture[] = [];
      for (const material of Object.values(materials) as Material[]) shelf.add(new Mesh(warmBox, material));
      shelf.add(new Mesh(warmBox, new MeshPhysicalMaterial({ clearcoat: 0.6 })), new Mesh(warmBox, new MeshBasicMaterial({ map: new CanvasTexture(document.createElement('canvas')), transparent: true, toneMapped: false })), new Mesh(warmBox, new MeshStandardMaterial({ transparent: true, depthWrite: false })));
      const worker = workerKit?.spawn('#888888', 20, 0.2);
      const walker = workerKit?.spawn('#888888', 20, 0.7);
      for (const person of [worker, walker]) {
        if (person) shelf.add(person.root);
      }
      for (const name of PROP_NAMES) {
        const prop = propKit?.make(name, 10);
        if (prop) shelf.add(prop);
      }
      shelf.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        // Whether it receives shadows is part of which shader it needs.
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as MeshStandardMaterial[]) {
          for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) if (map) textures.push(map);
        }
      });
      scene.add(shelf);
      camera.updateProjectionMatrix();
      void renderer.compileAsync(shelf, camera, scene).then(() => {
        for (const texture of new Set(textures)) renderer.initTexture(texture);
        scene.remove(shelf);
      });
    };
    // Not every browser has it.
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 1500);
  });
  const warmBox = new BoxGeometry(1, 1, 1);

  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  document.body.append(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.46;
  pmrem.dispose();


  const camera = new PerspectiveCamera(FOV, 1, 10, 30_000);
  const key = new DirectionalLight('#fff3e2', 3.1);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.6;
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const sky = new HemisphereLight('#f4f7ff', '#8a8578', 0.35);
  scene.add(sky);

  // Fog and paper are for a room: too far away to see until one piece of work has the floor. The fog is there
  // from the start, because adding it later would recompile every material in the middle of a move.
  const fog = new Fog(PAPER, 1e6, 2e6);
  scene.fog = fog;
  const backdrop = createBackdrop(14_000);
  scene.add(backdrop.mesh);

  // The ground under everything: a dark top that falls away into the room, under a pool of light.
  const tableFade = document.createElement('canvas');
  tableFade.width = 512;
  tableFade.height = 512;
  const tablePaint = tableFade.getContext('2d')!;
  const fade = tablePaint.createRadialGradient(256, 256, 40, 256, 256, 256);
  fade.addColorStop(0, '#ffffff');
  fade.addColorStop(0.55, '#8c8c8c');
  fade.addColorStop(1, '#000000');
  tablePaint.fillStyle = fade;
  tablePaint.fillRect(0, 0, 512, 512);
  const tableMaterial = new MeshStandardMaterial({ color: cssColor(tokenColor('--gray-600')), roughness: 0.82, transparent: true, opacity: 0, alphaMap: new CanvasTexture(tableFade) });
  const tableDark = tableMaterial.color.clone();
  const tableGround = new Color(PAPER);
  const table = new Mesh(new PlaneGeometry(1, 1), tableMaterial);
  table.receiveShadow = true;
  table.visible = false;
  table.renderOrder = -3;
  scene.add(table);

  let width = window.innerWidth;
  let height = window.innerHeight;
  /** The part of the window the canvas covers, when it is not all of it: the chart's side, for the building. */
  let inset: { left: number; top: number; width: number; height: number } | null = null;
  /** `fromView`: the view itself moved the canvas, so it already knows; telling it again would go round in a loop. */
  let sizedAs = '';
  function resize(fromView = false): void {
    width = inset ? inset.width : window.innerWidth;
    height = inset ? inset.height : window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio, PIXEL_RATIOS[Math.min(quality, PIXEL_RATIOS.length - 1)]!);
    const size = `${width}x${height}@${ratio}`;
    if (size !== sizedAs) {
      sizedAs = size;
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (live && !fromView) site.resized();
    wake();
  }

  const fitShadow = (x: number, y: number, reach: number): void => {
    key.position.set(x - reach * 0.95, y - reach * 0.7, reach * 2);
    key.target.position.set(x, y, 0);
    const shadow = key.shadow.camera;
    shadow.left = -reach;
    shadow.right = reach;
    shadow.top = reach;
    shadow.bottom = -reach;
    shadow.near = 1;
    shadow.far = reach * 6;
    shadow.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------------------------------
  // The camera: choreographed into place, then it is the person's, with the usual controls
  // ---------------------------------------------------------------------------------------

  let live = false;
  let pose: Pose = restPose(window.innerHeight);
  let tooltipWasDisabled = false;

  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = 1.42;
  controls.rotateSpeed = 0.55;
  controls.addEventListener('change', () => wake());
  // The wheel is handled below, so it can tell a mouse from a trackpad. A touch screen's pinch still comes here.
  controls.zoomToCursor = false;

  // The board moves like a map, since finding a place on it is the point; one piece of work turns like an object.
  let bounds: { w: number; d: number } | null = null;
  function setControlStyle(asMap: boolean): void {
    controls.mouseButtons = asMap ? { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE } : { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    controls.touches = asMap ? { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE } : { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
    canvas.classList.toggle('moves-like-a-map', asMap);
  }

  /** Hands the camera over at this pose: from here on it follows the person's mouse. */
  function handToControls(at: Pose, within?: { w: number; d: number }, farthest = 0): void {
    bounds = within ?? null;
    setControlStyle(Boolean(within));
    placeCamera(camera, at);
    camera.matrixAutoUpdate = true;
    camera.quaternion.setFromRotationMatrix(camera.matrix);
    controls.target.set(at.x, at.y, at.z);
    controls.minDistance = at.distance * (within ? 0.2 : 0.3);
    // Landed close up on part of the board, the whole of it is still within reach.
    controls.maxDistance = Math.max(at.distance, farthest) * (within ? 2.2 : 1.9);
    controls.enabled = true;
    zoomLeft = 0;
    controls.update();
  }

  /** Takes the camera back for a choreographed move, starting from wherever the person left it. */
  function takeFromControls(): Pose {
    controls.enabled = false;
    return poseOfCamera(camera.position, controls.target);
  }

  function setInset(rect: { left: number; top: number; width: number; height: number } | null): void {
    inset = rect;
    canvas.classList.toggle('is-inset', Boolean(rect));
    if (rect) Object.assign(canvas.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    else for (const name of ['left', 'top', 'width', 'height', 'opacity']) canvas.style.removeProperty(name);
    resize(true);
  }

  function setTable(on3d: boolean): void {
    live = on3d;
    const root = document.documentElement;
    // Over the chart's side only, the page stays as it is around it: its rows are part of the view.
    root.classList.toggle('fx3d-table', on3d && !inset);
    root.classList.toggle('fx3d-inset', on3d && Boolean(inset));
    root.dataset.fx3d = on3d ? (inset ? 'building' : 'site') : 'flat';
    canvas.classList.toggle('is-live', on3d);
    // A hover card left open over the bar would hang in the air all the way down (gantt-overlays.css).
    document.documentElement.classList.toggle('fx3d-live', on3d);
    // The chart may already be gone when the view is torn down with it (Start over): nothing to put back then.
    const tooltip = gantt.isDestroyed ? undefined : (gantt.features as unknown as { taskTooltip?: { disabled: boolean } } | undefined)?.taskTooltip;
    if (tooltip) {
      if (on3d) {
        tooltipWasDisabled = tooltip.disabled;
        tooltip.disabled = true;
      } else {
        tooltip.disabled = tooltipWasDisabled;
      }
    }
    if (!on3d) {
      page.style.removeProperty('opacity');
      table.visible = false;
      controls.enabled = false;
    }
    companion.wake();
  }

  function showTable(x: number, y: number, z: number, reach: number, opacity: number, ground: number): void {
    table.visible = opacity > 0.01;
    table.position.set(x, y, z);
    table.scale.set(reach * 4, reach * 4, 1);
    tableMaterial.opacity = opacity;
    tableMaterial.color.lerpColors(tableDark, tableGround, ground);
  }

  /** How much of a room's setting is in: the plain paper, and the fog that takes the rest of the sheet away with distance. */
  function setAtmosphere(shown: number, focusDistance: number): void {
    backdrop.set(shown);
    const strength = Math.max(0.001, shown);
    fog.near = (focusDistance + 260) / strength;
    fog.far = (focusDistance + 1500) / strength;
  }

  const moved = new Vector3();
  /** Moves the camera and what it looks at together, keeping the table in reach. */
  function moveView(dx: number, dy: number): void {
    moved.set(dx, dy, 0);
    controls.target.add(moved);
    camera.position.add(moved);
  }
  function holdOverTable(): void {
    if (!bounds) return;
    const [x, y] = [controls.target.x, controls.target.y];
    const [limitX, limitY] = [bounds.w * 0.55, bounds.d * 0.55];
    const [nextX, nextY] = [Math.min(limitX, Math.max(-limitX, x)), Math.min(limitY, Math.max(-limitY, y))];
    if (nextX !== x || nextY !== y) moveView(nextX - x, nextY - y);
  }

  /** Moves across the ground by this many pixels of the screen, whichever way the camera faces. */
  function moveByPixels(across: number, along: number): void {
    const distance = camera.position.distanceTo(controls.target);
    const scale = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height;
    const azimuth = Math.atan2(camera.position.x - controls.target.x, -(camera.position.y - controls.target.y));
    moveView((Math.cos(azimuth) * across - Math.sin(azimuth) * along) * scale, (Math.sin(azimuth) * across + Math.cos(azimuth) * along) * scale);
  }

  function stepOrbit(step: OrbitStep): void {
    const offset = steppedOffset(camera.position.clone().sub(controls.target), step, { minPolar: controls.minPolarAngle, maxPolar: controls.maxPolarAngle, minDistance: controls.minDistance, maxDistance: controls.maxDistance });
    camera.position.set(controls.target.x + offset.x, controls.target.y + offset.y, controls.target.z + offset.z);
  }

  // Zoom eases in over a few frames and stays anchored on what is under the pointer.
  let zoomLeft = 0;
  const zoomAt = new Vector3();
  const zoomRay = new Raycaster();
  const zoomPointer = new Vector2();
  function aimZoom(clientX: number, clientY: number): void {
    const box = canvas.getBoundingClientRect();
    const [x, y] = [clientX - box.left, clientY - box.top];
    zoomPointer.set((x / width) * 2 - 1, 1 - (y / height) * 2);
    camera.updateMatrixWorld();
    zoomRay.setFromCamera(zoomPointer, camera);
    const { origin, direction } = zoomRay.ray;
    const along = direction.z < -0.001 ? -origin.z / direction.z : camera.position.distanceTo(controls.target);
    zoomAt.copy(origin).addScaledVector(direction, along);
  }
  function runZoom(dt: number): void {
    if (Math.abs(zoomLeft) < 0.0005) {
      zoomLeft = 0;
      return;
    }
    const now = zoomLeft * (1 - Math.exp(-16 * dt));
    zoomLeft -= now;
    const distance = camera.position.distanceTo(controls.target);
    const factor = Math.min(controls.maxDistance, Math.max(controls.minDistance, distance * Math.exp(now))) / distance;
    // Scaling the camera and its target about one point keeps that point still on the screen.
    const targetHeight = controls.target.z;
    camera.position.sub(zoomAt).multiplyScalar(factor).add(zoomAt);
    controls.target.sub(zoomAt).multiplyScalar(factor).add(zoomAt);
    controls.target.z = targetHeight;
  }

  let wheelGesture: WheelGesture | null = null;
  const onCanvasWheel = (event: WheelEvent): void => {
    if (!controls.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? height : 1;
    const [dx, dy] = [event.deltaX * unit, event.deltaY * unit];
    // Shift and two fingers, or a shifted wheel, turn and tilt without needing a right button.
    if (event.shiftKey) {
      stepOrbit({ turn: -(dx || 0) * 0.004, tilt: dy * 0.003 });
      wake();
      return;
    }
    wheelGesture = wheelAction(event, wheelGesture, event.timeStamp);
    if (wheelGesture.action === 'zoom') {
      const amount = Math.max(-120, Math.min(120, dy));
      zoomLeft += amount * (Math.abs(amount) < 30 ? 0.012 : 0.0022);
      aimZoom(event.clientX, event.clientY);
    } else if (bounds) {
      moveByPixels(dx, -dy);
    } else {
      // Inside one piece of work two fingers turn it, as with any object on a screen.
      stepOrbit({ turn: dx * 0.004, tilt: -dy * 0.003 });
    }
    wake();
  };

  // A click is a press that did not travel: anything further is the person moving the camera.
  let pressed: { x: number; y: number } | null = null;
  const onCanvasDown = (event: PointerEvent): void => {
    pressed = { x: event.clientX, y: event.clientY };
  };
  // In the canvas's own pixels, wherever it is on the page.
  const local = (event: MouseEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const onCanvasMove = (event: PointerEvent): void => {
    if (!pressed && live) site.hover(...local(event));
  };
  const onCanvasUp = (event: PointerEvent): void => {
    const travelled = pressed ? Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) : 99;
    pressed = null;
    if (live && travelled < 5) site.click(...local(event));
  };
  const onCanvasDoubleClick = (event: MouseEvent): void => {
    if (live) site.doubleClick(...local(event));
  };

  // ---------------------------------------------------------------------------------------
  // The site: the board, and one piece of work inside it
  // ---------------------------------------------------------------------------------------

  const panel = createSidePanel({
    showTab: showPanelTab,
    hasAssistant,
    reducedMotion,
    onChange: (opening) => site.panelChanged(opening),
  });

  const siteContext: SiteContext = {
    gantt,
    look,
    scene,
    camera,
    renderer,
    materials,
    reducedMotion,
    size: () => ({ width, height }),
    workers: () => workerKit,
    props: () => propKit,
    workersReady,
    pin: () => pin,
    makeBlockFace: (wrap, bar) => paintFace(wrap, bar, bar.getBoundingClientRect()),
    setLive: (on3d) => {
      setTable(on3d);
      syncDock();
    },
    sheetOpacity: (value) => {
      if (value >= 1) page.style.removeProperty('opacity');
      else page.style.opacity = String(value);
    },
    sheetTransform: (scale, x = 0, y = 0) => {
      if (scale === null) {
        page.style.removeProperty('transform');
        page.style.removeProperty('transform-origin');
        page.style.removeProperty('will-change');
        return;
      }
      page.style.willChange = 'transform';
      page.style.transformOrigin = `${width / 2}px ${height / 2}px`;
      page.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    },
    fitShadow,
    showTable,
    setAtmosphere,
    handToControls,
    takeFromControls,
    wake: () => wake(),
    editTask,
    selectTask,
    ...(openFix ? { openPayment: openFix } : {}),
    panel,
    // Remy's face over the scene while Remy is on a call: it reads the camera and where the scene is drawn.
    companion: createCompanion({
      camera: () => camera,
      view: () => inset ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      up: () => live && (site.settled?.() ?? true),
      reducedMotion,
    }),
  };
  const { companion } = siteContext;

  const board = createSiteView(siteContext);
  // A plan that is a building opens as the building, over the chart's side, with the rows beside it.
  const building = createBuildingView(siteContext, { setInset, lights: { sun: key, sky } });
  // A plan that is a building is made ready ahead of its first visit, once the page has settled.
  void workersReady.then(() => {
    if (building.fits()) void building.warm();
  });
  let active: SiteView = board;
  const site: SiteView & { render?(): boolean; quality?(level: number): void } = {
    open: async (work) => {
      active = building.fits() ? building : board;
      await active.open(work);
    },
    close: (after) => active.close(after),
    up: () => active.up(),
    lastWork: () => board.lastWork(),
    update: (dt, time) => active.update(dt, time),
    afterCamera: () => active.afterCamera(),
    hover: (x, y) => active.hover(x, y),
    click: (x, y) => active.click(x, y),
    doubleClick: (x, y) => active.doubleClick(x, y),
    resized: () => active.resized(),
    planChanged: () => {
      active.planChanged();
      syncDock();
    },
    show: (taskIds) => active.show(taskIds),
    settled: () => active.settled?.() ?? true,
    crane: (look) => active.crane?.(look) ?? false,
    get control() {
      return active.control;
    },
    panelChanged: (opening) => active.panelChanged(opening),
    render: () => active === building && building.render(),
    quality: (level) => building.quality(level),
    destroy: () => {
      building.destroy();
      board.destroy();
    },
  };

  // ---------------------------------------------------------------------------------------
  // The way in, from the chart
  // ---------------------------------------------------------------------------------------

  const dock = document.createElement('div');
  dock.className = 'fx3d-dock';
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', 'Chart or site');
  // Two ways to see the plan, side by side in one control: which one is on show, and the way to the other, are the same thing.
  const toggle = document.createElement('div');
  toggle.className = 'fx3d-toggle';
  toggle.setAttribute('role', 'radiogroup');
  toggle.setAttribute('aria-label', 'View the plan as');
  const chartButton = document.createElement('button');
  chartButton.type = 'button';
  chartButton.className = 'fx3d-toggle-option';
  chartButton.setAttribute('role', 'radio');
  chartButton.dataset.testid = 'view-chart';
  chartButton.innerHTML = '<i class="fa fa-chart-gantt" aria-hidden="true"></i><span>Chart</span>';
  chartButton.title = 'The chart (Esc from the site)';
  chartButton.addEventListener('click', () => {
    if (live) site.close();
  });
  const siteButton = document.createElement('button');
  siteButton.type = 'button';
  siteButton.className = 'fx3d-toggle-option';
  siteButton.setAttribute('role', 'radio');
  siteButton.dataset.testid = 'view-site';
  siteButton.addEventListener('click', () => {
    if (!live) void site.open();
  });
  toggle.append(chartButton, siteButton);
  // Someone who left a piece of work to edit it, or to pay for it, gets a way straight back.
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'button is-sm is-quiet';
  backButton.hidden = true;
  backButton.addEventListener('click', () => {
    if (!live) void site.open(site.lastWork() ?? undefined);
  });
  dock.append(toggle, backButton);

  function syncDock(): void {
    const work = board.lastWork();
    backButton.hidden = !work || live;
    if (work) backButton.textContent = `Back to ${work.name ?? 'the work'}`;
    const isBuilding = building.fits();
    siteButton.innerHTML = `<i class="fa fa-${isBuilding ? 'building' : 'cube'}" aria-hidden="true"></i><span>${isBuilding ? 'Site view' : 'Site board'}</span>`;
    siteButton.title = isBuilding ? 'The plan as the building, on the date you choose' : 'The plan as a site, on the date you choose';
    siteButton.dataset.view = isBuilding ? 'building' : 'board';
    const onSite = live;
    chartButton.classList.toggle('is-on', !onSite);
    siteButton.classList.toggle('is-on', onSite);
    chartButton.setAttribute('aria-checked', String(!onSite));
    siteButton.setAttribute('aria-checked', String(onSite));
  }

  (document.querySelector('[data-fx3d-slot]') ?? document.body).append(dock);
  syncDock();

  // Zoom, turn and tilt for anyone, whatever they are holding. The keys do the same.
  const pad = createViewPad(
    () => live && controls.enabled,
    () => wake(),
  );
  document.body.append(pad.element);

  // ---------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------

  let raf = 0;
  let last = 0;
  let time = 0;

  // On a machine that cannot keep up, sharpness goes first and then the moving shadows, so the motion stays smooth.
  let quality = 0;
  let paceFrom = 0;
  let paceFrames = 0;
  let paceLast = 0;
  function keepPace(at: number): void {
    // A long gap is a hidden tab or the board being built, which says nothing about keeping up.
    if (at - paceLast > 400) paceFrames = 0;
    paceLast = at;
    if (paceFrames === 0) paceFrom = at;
    paceFrames += 1;
    const span = at - paceFrom;
    if (span < 1500) return;
    const slow = paceFrames / (span / 1000) < QUALITY_FLOOR_FPS;
    paceFrames = 0;
    if (!slow || quality >= PIXEL_RATIOS.length) return;
    quality += 1;
    const ratio = PIXEL_RATIOS[quality];
    if (ratio !== undefined) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio));
      renderer.setSize(width, height, false);
      sizedAs = `${width}x${height}@${Math.min(window.devicePixelRatio, ratio)}`;
    }
    canvas.dataset.quality = String(quality);
    site.quality?.(quality);
    if (live) site.resized();
  }

  function wake(): void {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function frame(now: number): void {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    time += dt;
    if (live) keepPace(now);
    if (live) pose = site.update(dt, time) ?? pose;
    else pose = restPose(height);
    if (controls.enabled) {
      if (pad.active()) {
        pad.apply(dt, {
          step: stepOrbit,
          move: (across, along) => moveByPixels(across * height * 0.6, along * height * 0.6),
        });
      }
      runZoom(dt);
      controls.update();
      holdOverTable();
    } else {
      placeCamera(camera, pose);
    }
    if (live) companion.wake();
    if (live) site.afterCamera();
    if (quality >= PIXEL_RATIOS.length) renderer.shadowMap.needsUpdate = false;
    if (!(live && site.render?.())) renderer.render(scene, camera);
    // The controls' change event may already have asked for the next frame; two would soon be thousands.
    if (live && !raf) raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------

  // A bar's right-click menu leads in here; its double-click stays the task editor, as everywhere else.
  const stopMenu = (gantt as unknown as { on(listeners: Record<string, unknown>): () => void }).on({
    taskMenuBeforeShow: ({ items, taskRecord }: { items: Record<string, unknown>; taskRecord?: TaskModel }) => {
      if (!taskRecord) return;
      const isWork = taskRecord.isLeaf && !taskRecord.isMilestone;
      // In a building, any row has its pieces: a group opens on all of its rows.
      const inBuilding = building.fits();
      items.openIn3d = {
        text: inBuilding ? 'Show in the site view' : isWork ? 'Open 3D view' : 'Open the site board',
        icon: 'fa fa-cube',
        weight: 101,
        onItem: () => {
          if (!live) void site.open(isWork || inBuilding ? taskRecord : undefined);
        },
      };
    },
  });
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !live) return;
    // Someone typing in the side panel, or in one of its date pickers, is not asking to leave.
    if ((event.target as HTMLElement | null)?.closest?.('.inspector-host, .b-float-root')) return;
    // One step at a time: the panel goes first.
    if (panel.isOpen()) panel.close();
    else site.up();
    event.stopPropagation();
    event.preventDefault();
  };

  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasMove);
  canvas.addEventListener('pointerup', onCanvasUp);
  canvas.addEventListener('dblclick', onCanvasDoubleClick);
  // Before the controls' own listener, so it can take trackpad scrolling for itself.
  canvas.addEventListener('wheel', onCanvasWheel, { capture: true, passive: false });
  window.addEventListener('keydown', onKeyDown, true);
  const onWindowResize = (): void => resize();
  window.addEventListener('resize', onWindowResize);
  resize();

  // A change comes as a burst of them: one reading, once it has passed.
  let planTimer = 0;
  return {
    planChanged() {
      if (!live) return;
      window.clearTimeout(planTimer);
      planTimer = window.setTimeout(() => {
        if (live) site.planChanged();
      }, 140);
    },
    show(taskIds) {
      if (live) site.show(taskIds);
    },
    // What the Chart and Site view buttons do, for Remy when someone asks her.
    async openSite() {
      if (!live) await site.open();
      return live;
    },
    closeSite() {
      if (live) site.close();
    },
    siteOpen: () => live,
    siteSettled: () => live && (site.settled?.() ?? true),
    crane: (look) => site.crane?.(look) ?? false,
    siteControl: () => (live ? (site.control ?? null) : null),
    destroy() {
      window.clearTimeout(planTimer);
      companion.dispose();
      site.destroy();
      panel.destroy();
      cancelAnimationFrame(raf);
      controls.dispose();
      pad.destroy();
      stopMenu();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onWindowResize);
      setTable(false);
      dock.remove();
      canvas.remove();
      disposeDeep(scene);
      renderer.dispose();
    },
  };
}
