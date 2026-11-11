/**
 * The people on site, each a rigged model cloned per person, with a hard hat in the firm's color, as on the chart.
 * Those at the job stay at it, in hi-vis, hammering (jungle_jim's worker, whose one motion that is); the rest amble
 * between spots and lend a hand (Quaternius's, which has a walk). Someone who is only planned for later stands still
 * as a pale figure, like a bar that has not started.
 */
import { type AnimationAction, type AnimationClip, AnimationMixer, Box3, type BufferGeometry, CircleGeometry, Color, CylinderGeometry, Group, type Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, type Skeleton, type SkinnedMesh, SphereGeometry, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Spot, Stop } from './room-jobs';

const CLIPS = { walk: 'CharacterArmature|Walk', stand: 'CharacterArmature|Idle_Neutral', hands: 'CharacterArmature|Interact', wave: 'CharacterArmature|Wave' };
export type Pose = keyof typeof CLIPS;
/** How the hi-vis worker's helmet sits: fitted over the one in its texture, which cannot be recolored. */
const HELMET = { lift: 0.018, radius: 0.215, brim: 0.262 };

export interface Area {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface Worker {
  root: Group;
  /** Places them and sets where they may wander. */
  roam(area: Area): void;
  /** A place of their own: those at the job stand there, those who amble stay around it. */
  standAt(x: number, y: number, area: Area): void;
  /** Whether they can go from one place to another; if not, a job has one stop for them. */
  walks: boolean;
  /** A job in a room: they go from stop to stop, doing what each one says, facing what it says. */
  follow(stops: readonly Stop[]): void;
  /** Their height, which follows the scale of the scene they are in. */
  resize(height: number): void;
  /** On site they move and wear their gear; off site they stand as a pale figure. */
  setOnSite(onSite: boolean): void;
  /** Moves on; with a stride, only every so many calls, by all the time since. */
  update(dt: number, stride?: number): void;
}

export interface WorkerKit {
  spawn(hatColor: string, height: number, seed: number): Worker;
}

/** Spreads a seed into a repeatable number from 0 to 1, so a crew moves the same way each time it opens. */
const scatter = (seed: number): number => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43_758.5453;
  return value - Math.floor(value);
};

/**
 * What someone who ambles is doing: walking somewhere, working at a spot, or waiting off site. The clip is set in the
 * same breath as the state, and only `step` moves them, only while walking: so nobody slides in another clip's pose.
 */
export function createAmble(seed: number, play: (pose: Pose) => void) {
  let area: Area = { x: 0, y: 0, w: 1, d: 1 };
  let goalX = 0;
  let goalY = 0;
  let wait = 0;
  let walking = false;
  let onSite = false;
  let count = seed * 7;
  // A job: where to go next, instead of anywhere in the area.
  let route: readonly Stop[] | null = null;
  let leg = 0;
  let facing: Spot | null = null;

  const pickGoal = (): void => {
    count += 1;
    const stop = route?.[leg % route.length];
    goalX = stop ? stop.x : area.x + (scatter(seed + count) - 0.5) * area.w;
    goalY = stop ? stop.y : area.y + (scatter(seed + count + 0.37) - 0.5) * area.d;
    facing = null;
    walking = true;
    play('walk');
  };
  const stopAndWork = (): void => {
    walking = false;
    count += 1;
    const stop = route?.[leg % route.length];
    if (route && stop) {
      leg += 1;
      // With one stop they stay at it, whatever the hold says.
      wait = route.length === 1 ? Infinity : stop.hold;
      facing = stop.face ?? null;
      play(stop.pose);
      return;
    }
    wait = 2.5 + scatter(seed + count + 0.13) * 5;
    if (scatter(seed + count + 0.71) < 0.72) {
      play('hands');
    } else {
      play('stand');
      wait *= 0.5;
    }
  };

  return {
    begin(next: Area): void {
      area = next;
      route = null;
      facing = null;
      walking = false;
      if (!onSite) play('stand');
      else if (scatter(seed + count) > 0.5) pickGoal();
      else stopAndWork();
    },
    /** Comes to a stop here, and works around this area from now on. */
    stopAt(next: Area): void {
      area = next;
      route = null;
      facing = null;
      walking = false;
      if (onSite) stopAndWork();
      else play('stand');
    },
    /** Takes up a job, from the first of its stops. */
    follow(stops: readonly Stop[]): void {
      route = stops;
      leg = 0;
      facing = null;
      walking = false;
      if (onSite) pickGoal();
      else play('stand');
    },
    setOnSite(next: boolean): void {
      onSite = next;
      walking = false;
      if (!next) play('stand');
      else if (route) pickGoal();
      else stopAndWork();
    },
    step(dt: number, at: { x: number; y: number; heading: number }, size: number): void {
      if (!onSite) return;
      if (!walking) {
        if (facing) {
          const wanted = Math.atan2(facing.y - at.y, facing.x - at.x);
          at.heading += Math.atan2(Math.sin(wanted - at.heading), Math.cos(wanted - at.heading)) * (1 - Math.exp(-5 * dt));
        }
        wait -= dt;
        if (wait <= 0) pickGoal();
        return;
      }
      const dx = goalX - at.x;
      const dy = goalY - at.y;
      if (Math.hypot(dx, dy) < size * 0.12) {
        stopAndWork();
        return;
      }
      // An amble: turn smoothly toward where they are going, and keep to a walking pace.
      const wanted = Math.atan2(dy, dx);
      const turn = Math.atan2(Math.sin(wanted - at.heading), Math.cos(wanted - at.heading));
      at.heading += turn * (1 - Math.exp(-5 * dt));
      const pace = size * 0.42 * dt * Math.max(0.2, Math.cos(turn));
      at.x += Math.cos(at.heading) * pace;
      at.y += Math.sin(at.heading) * pace;
    },
  };
}

/** A plain hard hat, standing on its own origin, in a material that takes each firm's color. */
function helmet(material: Material): Group {
  const hat = new Group();
  const dome = new Mesh(new SphereGeometry(HELMET.radius, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), material);
  const brim = new Mesh(new CylinderGeometry(HELMET.brim, HELMET.brim, 0.03, 18), material);
  brim.position.set(0, 0.005, 0.04);
  hat.add(dome, brim);
  hat.userData.helmet = true;
  return hat;
}

export async function loadWorkers(): Promise<WorkerKit | null> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let gltf: { scene: Group; animations: AnimationClip[] };
  let hammerer: { scene: Group; animations: AnimationClip[] } | null = null;
  try {
    [gltf, hammerer] = await Promise.all([loader.loadAsync('/models/worker.glb'), loader.loadAsync('/models/worker-hammer.glb').catch(() => null)]);
  } catch {
    return null; // The models fall back to the simple figures.
  }
  const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
  gltf.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(gltf.scene, true);
  const modelHeight = Math.max(0.001, bounds.max.y - bounds.min.y);

  const shared = <T extends Material>(material: T): T => {
    material.userData.shared = true;
    return material;
  };
  const shareAll = (scene: Group): void => {
    scene.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.userData.shared = true;
      shared(mesh.material as Material);
      (mesh.material as MeshStandardMaterial).roughness = 0.72;
    });
  };
  shareAll(gltf.scene);
  const hats = new Map<string, MeshStandardMaterial>();
  const hat = (color: string): MeshStandardMaterial => {
    let material = hats.get(color);
    if (!material) {
      material = shared(new MeshStandardMaterial({ color: new Color(color), roughness: 0.38 }));
      hats.set(color, material);
    }
    return material;
  };
  const pale = shared(new MeshStandardMaterial({ color: '#d8dade', roughness: 0.9 }));
  const blobMaterial = shared(new MeshBasicMaterial({ color: '#10151c', transparent: true, opacity: 0.22, depthWrite: false }));
  const blobGeometry: BufferGeometry = new CircleGeometry(0.2, 18);
  blobGeometry.userData.shared = true;

  // The hi-vis worker: fit a helmet to its head once, on the original, so every copy has one to recolor.
  let hammerHeight = 1;
  let hammerFloor = 0;
  if (hammerer) {
    shareAll(hammerer.scene);
    hammerer.scene.updateMatrixWorld(true);
    const box = new Box3().setFromObject(hammerer.scene, true);
    hammerHeight = Math.max(0.001, box.max.y - box.min.y);
    hammerFloor = box.min.y;
    let head: Object3D | null = null;
    hammerer.scene.traverse((child) => {
      if (!head && /CC_Base_Head/.test(child.name) && !/scaleCompensation/.test(child.name)) head = child;
    });
    if (head) {
      const bone = head as Object3D;
      const hatGroup = helmet(pale);
      hammerer.scene.add(hatGroup);
      hatGroup.position.set(bone.getWorldPosition(new Vector3()).x, box.max.y - HELMET.radius + HELMET.lift, bone.getWorldPosition(new Vector3()).z);
      hatGroup.updateMatrixWorld(true);
      bone.attach(hatGroup);
    }
  }

  return {
    spawn(hatColor, height, seed) {
      // Some people hammer, some amble and work with their hands, and it stays that way.
      const atTheJob = hammerer !== null && scatter(seed + 0.5) > 0.42;
      const source = atTheJob ? hammerer! : gltf;
      const model = cloneRig(source.scene) as Group;
      // The model stands along y; the site's up is z.
      const holder = new Group();
      holder.rotation.x = Math.PI / 2;
      const across = atTheJob ? hammerHeight : modelHeight;
      holder.scale.setScalar(1 / across);
      holder.position.z = (atTheJob ? -hammerFloor : -bounds.min.y) / across;
      holder.add(model);
      const root = new Group();
      root.add(holder);

      const meshes: { mesh: Mesh; real: Material }[] = [];
      model.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        const material = mesh.material as Material;
        const inHelmet = Boolean(child.parent?.userData.helmet);
        const onTheHead = (child.parent?.name ?? '').includes('Worker_Head') || child.name.includes('Worker_Head');
        const real = inHelmet || (onTheHead && material.name === 'Worker_Yellow') ? hat(hatColor) : material;
        mesh.material = real;
        meshes.push({ mesh, real });
      });

      const blob = new Mesh(blobGeometry, blobMaterial);
      blob.position.z = 0.012;
      root.add(blob);

      const mixer = new AnimationMixer(model);
      const actions = {} as Record<Pose, AnimationAction>;
      let working: AnimationAction | null = null;
      if (atTheJob) {
        const clip = source.animations[0];
        if (clip) {
          working = mixer.clipAction(clip);
          working.play();
          mixer.setTime(scatter(seed + 0.3) * clip.duration);
        }
      } else {
        for (const pose of Object.keys(CLIPS) as Pose[]) {
          const clip = clips.get(CLIPS[pose]);
          if (clip) actions[pose] = mixer.clipAction(clip);
        }
        if (actions.walk) actions.walk.timeScale = 0.8;
      }

      let current: AnimationAction | null = null;
      const play = (pose: Pose): void => {
        const next = actions[pose];
        if (!next || next === current) return;
        next.reset().play();
        if (current) next.crossFadeFrom(current, 0.28, false);
        current = next;
      };

      // Between strides nothing about this person has moved, so neither the walk over their bones nor their skin needs
      // redoing. Those two are the whole cost of a crowd, and they run every frame unless told otherwise.
      let resting = false;
      const followParents = root.updateMatrixWorld.bind(root);
      root.updateMatrixWorld = (force?: boolean): void => {
        if (!resting && root.visible) followParents(force);
      };
      const skins = new Set<Skeleton>();
      model.traverse((child) => {
        if ((child as SkinnedMesh).isSkinnedMesh) skins.add((child as SkinnedMesh).skeleton);
      });
      for (const skin of skins) {
        const redo = skin.update.bind(skin);
        skin.update = (): void => {
          if (!resting) redo();
        };
      }

      let size = height;
      root.scale.setScalar(size);
      let owed = 0;
      // Spread out, so that everyone on a stride does not land on the same frame.
      let turn = Math.floor(scatter(seed + 0.61) * 3);
      const amble = createAmble(seed, play);
      let onSite: boolean | null = null;
      const spot = { x: 0, y: 0, heading: scatter(seed) * Math.PI * 2 };
      const applySpot = (): void => {
        root.position.x = spot.x;
        root.position.y = spot.y;
        root.rotation.z = spot.heading + Math.PI / 2;
      };

      return {
        root,
        walks: !atTheJob,
        follow(stops) {
          const first = stops[0];
          if (!first) return;
          if (atTheJob) {
            spot.x = first.x;
            spot.y = first.y;
            if (first.face) spot.heading = Math.atan2(first.face.y - first.y, first.face.x - first.x);
            applySpot();
            return;
          }
          amble.follow(stops);
        },
        roam(area) {
          spot.x = area.x + (scatter(seed + 0.11) - 0.5) * area.w;
          spot.y = area.y + (scatter(seed + 0.23) - 0.5) * area.d;
          applySpot();
          if (atTheJob) return;
          amble.begin(area);
          // Everyone starts at a different point in their day.
          mixer.update(scatter(seed + 0.3) * 2);
        },
        standAt(x, y, area) {
          spot.x = x;
          spot.y = y;
          applySpot();
          if (!atTheJob) amble.stopAt(area);
        },
        resize(next) {
          size = next;
          root.scale.setScalar(next);
        },
        setOnSite(next) {
          if (next === onSite) return;
          onSite = next;
          for (const { mesh, real } of meshes) mesh.material = next ? real : pale;
          blob.visible = next;
          // Those not on site yet are quieter, but nobody ever stops moving.
          if (working) working.timeScale = next ? 1 : 0.5;
          else amble.setOnSite(next);
          // So there is a real pose even where nothing runs after this (reduced motion).
          mixer.update(working ? 0 : 0.4);
        },
        update(dt, stride = 1) {
          owed += dt;
          turn += 1;
          resting = turn < stride;
          if (resting) return;
          turn = 0;
          mixer.update(owed);
          const step = owed;
          owed = 0;
          if (working || !onSite) return;
          amble.step(step, spot, size);
          applySpot();
        },
      };
    },
  };
}
