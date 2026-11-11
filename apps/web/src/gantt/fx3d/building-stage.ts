/**
 * How the building is lit and drawn: a low afternoon sun from the front left with soft shadows, a pale sky over it,
 * the room-light reflections that give glass and steel their sheen, and three passes after the render: ambient
 * occlusion (the soft dark where things meet, which makes a model read as built), a gentle bloom that only lit fixtures
 * reach, and the output. The render target is multisampled, so edges stay clean without a blur pass.
 *
 * On a machine that cannot keep up, the occlusion goes first, then the bloom: `setQuality`.
 */
import {
  Color,
  DirectionalLight,
  HalfFloatType,
  HemisphereLight,
  type PerspectiveCamera,
  type Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface StageLights {
  sun: DirectionalLight;
  sky: HemisphereLight;
}

export interface Stage {
  /** Draws the frame through the passes (or straight, when quality says so). */
  render(): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** 0: everything; 1: no occlusion; 2: no passes at all. */
  setQuality(level: number): void;
  /** How much of the occlusion shows, to bring it in after a move rather than all at once. */
  setOcclusion(amount: number): void;
  /** Puts the sun's shadow over this much of the site. */
  fitShadow(center: Vector3, reach: number): void;
  /** Lights as the building wants them again, for another visit with the same stage. */
  dress(): void;
  /** Lights as they were before the building; `dress` puts the building's back. */
  restore(): void;
  /** The light over the site from the day (0) to a slate evening (1), where only lit fixtures still catch the eye. */
  setDusk(amount: number): void;
  /**
   * Draws the scene through every pass once, into the stage's own buffers rather than the screen: the shaders of
   * whatever is in the scene, its shadows and the passes compile now, not on the first frame anyone sees.
   */
  warm(): void;
  dispose(): void;
}

/** The site's light by day, as `dress` sets it, and at dusk: the sun gone down to a cool last light, and little from the sky. */
const DAY = { sun: new Color('#fff6ea'), sunPower: 3.3, sky: new Color('#e8eef8'), ground: new Color('#bdb7ab'), skyPower: 0.72, room: 0.55, bloomFrom: 4.5, bloom: 0.55 };
const DUSK = { sun: new Color('#8ea3c9'), sunPower: 0.42, sky: new Color('#7286aa'), ground: new Color('#3b4351'), skyPower: 0.5, room: 0.14, bloomFrom: 1.2, bloom: 0.8 };

/** The sun's direction: low from the front left, so the street faces are lit and shadows fall back and to the right. */
const SUN = new Vector3(-0.62, -0.82, 0.72).normalize();

export interface StageOptions {
  /** The bloom that lit fixtures reach; false leaves the pass out (a view that never lights them). Default true. */
  bloom?: boolean;
  /**
   * The canvas is see-through, with the page showing round the model: the output pass tone-maps each pixel's own color,
   * not its color times its coverage, so glass and soft edges over the page keep their color. Default false.
   */
  transparent?: boolean;
}

/** The output pass for a see-through canvas: its color taken apart from its coverage, then put back together. */
function seeThrough(pass: OutputPass): void {
  const shader = pass.material.fragmentShader;
  const sample = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  const end = shader.lastIndexOf('}');
  // A three.js whose shader reads otherwise keeps its own.
  if (!shader.includes(sample) || end < 0) return;
  const apart = `${sample}\n\t\t\tfloat coverage = gl_FragColor.a;\n\t\t\tgl_FragColor.rgb /= max( coverage, 1e-5 );`;
  pass.material.fragmentShader = `${shader.slice(0, end).replace(sample, apart)}\n\t\t\tgl_FragColor.rgb *= coverage;\n\t\t}`;
}

export function createStage(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, lights?: StageLights, options: StageOptions = {}): Stage {
  const own = !lights;
  const sun = lights?.sun ?? new DirectionalLight();
  const sky = lights?.sky ?? new HemisphereLight();
  if (own) scene.add(sun, sun.target, sky);
  const kept = { sun: { color: sun.color.clone(), intensity: sun.intensity, bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, radius: sun.shadow.radius }, sky: { color: sky.color.clone(), ground: sky.groundColor.clone(), intensity: sky.intensity }, environment: scene.environmentIntensity, exposure: renderer.toneMappingExposure };

  function dress(): void {
  sun.color.set('#fff6ea');
  sun.intensity = 3.3;
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00028;
  sun.shadow.normalBias = 0.45;
  sun.shadow.radius = 2.6;
  sky.color.set('#e8eef8');
  sky.groundColor.set('#bdb7ab');
  sky.intensity = 0.72;
  scene.environmentIntensity = 0.55;
  renderer.toneMappingExposure = 1.02;
  }
  dress();

  const size = renderer.getDrawingBufferSize(new Vector2());
  const target = new WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const occlusion = new GTAOPass(scene, camera, Math.max(1, size.x), Math.max(1, size.y));
  occlusion.updateGtaoMaterial({ radius: 9, distanceExponent: 1.4, thickness: 6, scale: 1.15, samples: 16, distanceFallOff: 1 });
  occlusion.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  occlusion.blendIntensity = 0.9;
  composer.addPass(occlusion);
  const bloom = options.bloom === false ? null : new UnrealBloomPass(new Vector2(Math.max(1, size.x), Math.max(1, size.y)), 0.55, 0.35, 4.5);
  if (bloom) composer.addPass(bloom);
  const output = new OutputPass();
  if (options.transparent) seeThrough(output);
  composer.addPass(output);
  let quality = 0;
  let occlusionAmount = 1;

  const apply = () => {
    occlusion.enabled = quality < 1 && occlusionAmount > 0.01;
    occlusion.blendIntensity = 0.9 * occlusionAmount;
    if (bloom) bloom.enabled = quality < 2;
  };
  apply();

  return {
    render() {
      if (quality >= 2) renderer.render(scene, camera);
      else composer.render();
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
    },
    setQuality(level) {
      quality = level;
      apply();
    },
    setOcclusion(amount) {
      occlusionAmount = amount;
      apply();
    },
    fitShadow(center, reach) {
      sun.position.copy(center).addScaledVector(SUN, reach * 2.4);
      sun.target.position.copy(center);
      sun.target.updateMatrixWorld();
      const shadow = sun.shadow.camera;
      shadow.left = -reach;
      shadow.right = reach;
      shadow.top = reach;
      shadow.bottom = -reach;
      shadow.near = 1;
      shadow.far = reach * 5;
      shadow.updateProjectionMatrix();
    },
    dress,
    setDusk(amount) {
      const mix = (day: number, dusk: number) => day + (dusk - day) * amount;
      sun.color.lerpColors(DAY.sun, DUSK.sun, amount);
      sun.intensity = mix(DAY.sunPower, DUSK.sunPower);
      sky.color.lerpColors(DAY.sky, DUSK.sky, amount);
      sky.groundColor.lerpColors(DAY.ground, DUSK.ground, amount);
      sky.intensity = mix(DAY.skyPower, DUSK.skyPower);
      scene.environmentIntensity = mix(DAY.room, DUSK.room);
      if (bloom) {
        bloom.threshold = mix(DAY.bloomFrom, DUSK.bloomFrom);
        bloom.strength = mix(DAY.bloom, DUSK.bloom);
      }
    },
    warm() {
      const toScreen = composer.renderToScreen;
      composer.renderToScreen = false;
      occlusion.enabled = true;
      if (bloom) bloom.enabled = true;
      composer.render();
      composer.renderToScreen = toScreen;
      apply();
    },
    restore() {
      sun.color.copy(kept.sun.color);
      sun.intensity = kept.sun.intensity;
      sun.shadow.bias = kept.sun.bias;
      sun.shadow.normalBias = kept.sun.normalBias;
      sun.shadow.radius = kept.sun.radius;
      sky.color.copy(kept.sky.color);
      sky.groundColor.copy(kept.sky.ground);
      sky.intensity = kept.sky.intensity;
      scene.environmentIntensity = kept.environment;
      renderer.toneMappingExposure = kept.exposure;
    },
    dispose() {
      composer.dispose();
      target.dispose();
      occlusion.dispose();
      bloom?.dispose();
      if (own) {
        scene.remove(sun, sun.target, sky);
        sun.dispose();
        sky.dispose();
      }
    },
  };
}

export const PAPER_COLOR = new Color('#f3f4ef');
