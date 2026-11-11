/**
 * What stands around in a room besides the work: real models of materials and site gear (credited in
 * public/models/CREDITS.md). Each is measured once when it loads, and copies share its geometry and materials. A prop
 * that fails to load simply isn't there, and the room draws its own simple stand-in.
 */
import { Box3, Group, type Material, type Mesh, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const PROP_NAMES = ['cement-bags', 'gravel', 'tubes', 'drywall', 'mixer', 'excavator', 'site-office'] as const;
export type PropName = (typeof PROP_NAMES)[number];

export interface PropKit {
  /** A copy standing on the ground at its origin, z up, this long along its longest side; null if it did not load. */
  make(name: PropName, longest: number): Group | null;
  /** A copy as it is in its file, with its parts and their pivots: for something that moves. */
  raw(name: PropName): Object3D | null;
}

/** How much to scale something of this size so its longest side is this long, and where its base and middle are. */
export function fitOnGround(size: { x: number; y: number; z: number }, longest: number): number {
  return longest / Math.max(0.001, size.x, size.y, size.z);
}

export async function loadProps(): Promise<PropKit> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loaded = new Map<PropName, { scene: Object3D; size: Vector3; middle: Vector3; floor: number }>();
  await Promise.all(
    PROP_NAMES.map(async (name) => {
      try {
        const { scene } = await loader.loadAsync(`/models/props/${name}.glb`);
        scene.updateMatrixWorld(true);
        scene.traverse((child) => {
          const mesh = child as Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.geometry.userData.shared = true;
          for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[]) material.userData.shared = true;
        });
        const bounds = new Box3().setFromObject(scene);
        loaded.set(name, { scene, size: bounds.getSize(new Vector3()), middle: bounds.getCenter(new Vector3()), floor: bounds.min.y });
      } catch {
        // Not there: the room makes do without it.
      }
    }),
  );
  return {
    raw(name) {
      return loaded.get(name)?.scene.clone(true) ?? null;
    },
    make(name, longest) {
      const prop = loaded.get(name);
      if (!prop) return null;
      const copy = prop.scene.clone(true);
      copy.position.set(-prop.middle.x, -prop.floor, -prop.middle.z);
      const upright = new Group();
      // The models stand along y; the site's up is z.
      upright.rotation.x = Math.PI / 2;
      upright.add(copy);
      const fitted = new Group();
      fitted.scale.setScalar(fitOnGround(prop.size, longest));
      fitted.add(upright);
      // What a room does to a prop (growing it, turning it, placing it) is on the outside, and the fit stays as it is.
      const holder = new Group();
      holder.add(fitted);
      return holder;
    },
  };
}
