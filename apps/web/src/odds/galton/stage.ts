/**
 * Where the board stands: one WebGL canvas in its container, a soft studio light (a warm key from the front left with
 * soft shadows, and a pale sky), the room reflections that give steel and satin their sheen, and a paper ground in
 * the page's own color that only shows the shadows. Sharp at the screen's pixel density (up to 2×, so a 1600×900
 * view records at 3200×1800), drawn only while something moves.
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The canvas's size in CSS pixels. */
  readonly size: { width: number; height: number };
  /** Puts the key light's shadow over a box of the scene. */
  fitShadow(center: Vector3, halfWidth: number, halfHeight: number, halfDepth: number): void;
  /** The ground's height (the bottom of whatever stands on it). */
  setGround(y: number): void;
  setBackground(color: Color): void;
  /** Asks for frames: `frame` is called each one until it returns false. */
  wake(): void;
  /**
   * Compiles every shader the scene needs (its shadows' too) and draws it once off screen, holding the screen's frames
   * meanwhile, so the first frame anyone sees doesn't stall on a compile.
   */
  warm(): Promise<void>;
  dispose(): void;
}

export interface StageOptions {
  /** Called every frame while awake, with the frame's time; returns whether anything still moves. */
  frame(now: number): boolean;
  /** Called after each frame is drawn. */
  drawn?(now: number): void;
  /** Called when the canvas changes size. */
  resized?(width: number, height: number): void;
  maxPixelRatio?: number;
  /** A paper ground that catches the key light's shadows (whatever stands on it can bring its own soft shadow instead). */
  ground?: boolean;
}

/** The key light comes from the front left and above. */
const KEY = new Vector3(-0.5, 0.74, 0.82).normalize();

export function createStage(container: HTMLElement, options: StageOptions): Stage {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const canvas = renderer.domElement;
  canvas.className = 'galton-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  container.prepend(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;
  pmrem.dispose();

  const camera = new PerspectiveCamera(20, 1, 4, 6000);

  const key = new DirectionalLight('#fff3e4', 2.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.04;
  scene.add(key, key.target);
  const sky = new HemisphereLight('#eef3fb', '#b3ac9f', 0.5);
  scene.add(sky);

  const ground = new Mesh(new PlaneGeometry(6000, 6000), new ShadowMaterial({ opacity: 0.075, depthWrite: false }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.renderOrder = -1;
  if (options.ground ?? true) scene.add(ground);

  const size = { width: 1, height: 1 };
  const maxRatio = options.maxPixelRatio ?? 2;
  let sizedAs = '';
  /** `quiet`: while the stage is being built, its owner isn't ready to be told yet. */
  function measure(quiet = false): void {
    const box = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    const ratio = Math.min(maxRatio, globalThis.devicePixelRatio || 1);
    const key = `${width}x${height}@${ratio}`;
    if (key === sizedAs) return;
    sizedAs = key;
    size.width = width;
    size.height = height;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (quiet) return;
    options.resized?.(width, height);
    wake();
  }
  const observer = new ResizeObserver(() => measure());
  observer.observe(container);

  let frameId = 0;
  let disposed = false;
  let holding = 0;
  function tick(now: number): void {
    frameId = 0;
    if (disposed) return;
    const busy = options.frame(now);
    if (holding > 0) {
      frameId = requestAnimationFrame(tick);
      return;
    }
    renderer.render(scene, camera);
    options.drawn?.(now);
    if (busy) frameId = requestAnimationFrame(tick);
  }
  function wake(): void {
    if (!disposed && !frameId) frameId = requestAnimationFrame(tick);
  }
  measure(true);

  return {
    canvas,
    renderer,
    scene,
    camera,
    size,
    fitShadow(center, halfWidth, halfHeight, halfDepth) {
      const reach = Math.hypot(halfWidth, halfHeight, halfDepth);
      key.position.copy(center).addScaledVector(KEY, reach * 2.2);
      key.target.position.copy(center);
      key.target.updateMatrixWorld();
      const shadow = key.shadow.camera;
      shadow.left = -reach;
      shadow.right = reach;
      shadow.top = reach;
      shadow.bottom = -reach;
      shadow.near = reach * 0.5;
      shadow.far = reach * 4;
      shadow.updateProjectionMatrix();
    },
    setGround(y) {
      ground.position.y = y;
    },
    setBackground(color) {
      scene.background = color;
    },
    wake,
    async warm() {
      holding += 1;
      // Drawn to the screen itself (a render target would compile other variants of every shader), out of sight.
      canvas.style.visibility = 'hidden';
      try {
        await renderer.compileAsync(scene, camera);
        if (disposed) return;
        renderer.render(scene, camera);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      } finally {
        canvas.style.visibility = '';
        holding -= 1;
        wake();
      }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      scene.environment?.dispose();
      ground.geometry.dispose();
      (ground.material as ShadowMaterial).dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
