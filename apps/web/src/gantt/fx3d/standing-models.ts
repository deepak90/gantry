/**
 * A small model that stands on the board and turns to face the camera: the pin that marks the work on the road
 * (pravdin's, credited in public/models/CREDITS.md). It comes back as one piece per material, ready to draw. If its file
 * does not load, the words beside it still say what it would.
 */
import { Box3, type BufferGeometry, type Color, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface SignPart {
  geometry: BufferGeometry;
  material: Material;
}

/** Stands geometry that is up along y and faces +z on its base, centered, at this height, up along z and facing -y. */
export function standSign(parts: readonly BufferGeometry[], height: number): void {
  for (const geometry of parts) geometry.rotateX(Math.PI / 2);
  const box = new Box3();
  for (const geometry of parts) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
  }
  const scale = height / Math.max(0.0001, box.max.z - box.min.z);
  const [cx, cy, floor] = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z];
  for (const geometry of parts) {
    geometry.translate(-cx, -cy, -floor);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
}

async function loadStanding(path: string, height: number, paint: (material: MeshStandardMaterial) => void): Promise<SignPart[] | null> {
  let scene: Object3D;
  try {
    ({ scene } = await new GLTFLoader().loadAsync(path));
  } catch {
    return null;
  }
  scene.updateMatrixWorld(true);
  const byMaterial = new Map<Material, BufferGeometry[]>();
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const baked = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(baked.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') baked.deleteAttribute(name);
    const material = mesh.material as Material;
    byMaterial.set(material, [...(byMaterial.get(material) ?? []), baked]);
  });
  const parts: SignPart[] = [];
  for (const [material, geometries] of byMaterial) {
    const geometry = mergeGeometries(geometries);
    for (const one of geometries) one.dispose();
    geometry.userData.shared = true;
    material.userData.shared = true;
    paint(material as MeshStandardMaterial);
    material.needsUpdate = true;
    parts.push({ geometry, material });
  }
  standSign(parts.map((part) => part.geometry), height);
  return parts;
}

/** Plain and dark: red is kept for what is wrong, and this only says where the work is. */
export const loadPin = (color: Color): Promise<SignPart[] | null> =>
  loadStanding('/models/map-pin.glb', 66, (material) => {
    material.map = null;
    material.color.copy(color);
    material.metalness = 0.1;
    material.roughness = 0.38;
  });
