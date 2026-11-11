/**
 * Where a person can be, and where they can go from there. There are three scenes, one inside the other:
 * the chart, the site board, and one piece of work. Every scene says how to go up, and walking the work
 * ends back on the board, so nothing is a dead end. The controls are drawn from this and nothing else.
 */
export type Scene<K> = { kind: 'chart' } | { kind: 'board' } | { kind: 'work'; work: K };

export interface NavPlan<K> {
  /** The work, in the order the road runs. */
  order: readonly K[];
  name: (work: K) => string;
}

export interface Step<K> {
  label: string;
  to: Scene<K>;
  role: 'up' | 'down' | 'previous' | 'next';
}

const CHART = { kind: 'chart' } as const;
const BOARD = { kind: 'board' } as const;

export function stepsFrom<K>(scene: Scene<K>, plan: NavPlan<K>): Step<K>[] {
  if (scene.kind === 'chart') return [{ label: 'Site board', to: BOARD, role: 'down' }];
  if (scene.kind === 'board') {
    const first = plan.order[0];
    return [{ label: 'Back to chart', to: CHART, role: 'up' }, ...(first === undefined ? [] : [{ label: `Walk the site from ${plan.name(first)}`, to: { kind: 'work' as const, work: first }, role: 'down' as const }])];
  }
  const at = plan.order.indexOf(scene.work);
  const before = plan.order[at - 1];
  const after = plan.order[at + 1];
  return [
    { label: 'Site board', to: BOARD, role: 'up' },
    ...(before === undefined ? [] : [{ label: plan.name(before), to: { kind: 'work' as const, work: before }, role: 'previous' as const }]),
    // The last piece of work leads back out to the board: walking the site always ends somewhere.
    after === undefined ? { label: 'Site board', to: BOARD, role: 'next' as const } : { label: plan.name(after), to: { kind: 'work' as const, work: after }, role: 'next' as const },
  ];
}

/** Where this scene sits, from the top: each part but the last is a way back. */
export function trailOf<K>(scene: Scene<K>, plan: NavPlan<K>): { label: string; to: Scene<K> | null }[] {
  if (scene.kind === 'chart') return [{ label: 'Chart', to: null }];
  if (scene.kind === 'board') return [{ label: 'Chart', to: CHART }, { label: 'Site board', to: null }];
  return [{ label: 'Chart', to: CHART }, { label: 'Site board', to: BOARD }, { label: plan.name(scene.work), to: null }];
}

/**
 * Where to go to show work someone pointed at from outside the scene (a card, a link, the task panel): into the room
 * of one piece of work, onto the board for several. With nothing to show, the scene stays as it is.
 */
export function sceneToShow<K>(works: readonly K[]): Scene<K> | null {
  const [first] = works;
  if (first === undefined) return null;
  return works.length === 1 ? { kind: 'work', work: first } : BOARD;
}

/** The work a pointed-at task stands for: itself, or everything inside a phase; once each, in the order asked. */
export function worksWithin<T extends { children?: unknown }>(tasks: readonly T[], isWork: (task: T) => boolean): T[] {
  const found = new Set<T>();
  const walk = (task: T): void => {
    if (isWork(task)) found.add(task);
    else if (Array.isArray(task.children)) (task.children as T[]).forEach(walk);
  };
  tasks.forEach(walk);
  return [...found];
}

/** One level up: what Esc does. The chart has nowhere further up to go. */
export function upFrom<K>(scene: Scene<K>): Scene<K> | null {
  if (scene.kind === 'work') return BOARD;
  if (scene.kind === 'board') return CHART;
  return null;
}
