/**
 * What a room stands on: a sheet of construction graph paper, with the rest of the site drawn on it as a plan. It runs
 * out to a plain paper horizon, with the fog in the same color, so the sheet has no edge to find.
 */
import { BackSide, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, PlaneGeometry, RepeatWrapping, ShaderMaterial, ShadowMaterial, SphereGeometry, SRGBColorSpace } from 'three';

export const PAPER = '#f3f4ef';
/** The thin line a plot is drawn in, on the plan around a room. */
export const PLAN_LINE = '#8ea5ba';
/** One square of the texture: five small squares a side, with a heavier line around them. */
const TILE = 100;

const fragment = /* glsl */ `
  uniform float opacity;
  uniform vec3 paper;
  void main() {
    gl_FragColor = vec4(paper * opacity, opacity);
  }
`;

const vertex = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface Backdrop {
  mesh: Mesh;
  /** How much of it shows. */
  set(shown: number): void;
}

/** The plain paper behind everything, which is all there is above the horizon. */
export function createBackdrop(radius: number): Backdrop {
  const material = new ShaderMaterial({
    uniforms: { opacity: { value: 0 }, paper: { value: new Color(PAPER).convertLinearToSRGB() } },
    vertexShader: vertex,
    fragmentShader: fragment,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  // Opaque, and first in line: everything else is drawn over it, and its alpha fades it in over the page.
  const mesh = new Mesh(new SphereGeometry(radius, 16, 10), material);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    mesh.position.copy(camera.position);
    mesh.updateMatrixWorld();
    mesh.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  };
  return {
    mesh,
    set(shown) {
      mesh.visible = shown > 0.004;
      material.uniforms.opacity!.value = shown;
    },
  };
}

function gridTexture(size: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = PAPER;
  paint.fillRect(0, 0, 1024, 1024);
  // Heavy for a drawn line, because a square of this is about 150 pixels on the screen.
  paint.fillStyle = '#c3d2df';
  for (let index = 1; index < 5; index++) {
    paint.fillRect((index * 1024) / 5 - 3, 0, 6, 1024);
    paint.fillRect(0, (index * 1024) / 5 - 3, 1024, 6);
  }
  // On the tile's edges, half each side, so it meets the next tile as one line.
  paint.fillStyle = '#93adc4';
  paint.fillRect(0, 0, 6, 1024);
  paint.fillRect(1018, 0, 6, 1024);
  paint.fillRect(0, 0, 1024, 6);
  paint.fillRect(0, 1018, 1024, 6);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(size / TILE, size / TILE);
  texture.anisotropy = 16;
  return texture;
}

/**
 * The sheet itself, lying just over the board and covering what it has printed. It is printed, not lit, so its paper is
 * the very color of the horizon and its lines stay lines; the shadows are a layer of their own on top.
 */
export function createGraphPaper(size: number): { group: Group; set(shown: number): void } {
  const sheetMaterial = new MeshBasicMaterial({ map: gridTexture(size), transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const shadowMaterial = new ShadowMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const geometry = new PlaneGeometry(size, size);
  const sheet = new Mesh(geometry, sheetMaterial);
  const shadows = new Mesh(geometry.clone(), shadowMaterial);
  shadows.receiveShadow = true;
  // First of what is see-through: drawn after it, the sheet would paint over the lettering on the walls.
  sheet.renderOrder = -2;
  shadows.renderOrder = -1;
  const group = new Group();
  group.position.z = 1;
  group.add(sheet, shadows);
  group.visible = false;
  return {
    group,
    set(shown) {
      group.visible = shown > 0.004;
      sheetMaterial.opacity = shown;
      shadowMaterial.opacity = shown * 0.24;
    },
  };
}
