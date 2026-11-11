/**
 * Where a library piece belongs in a group of the plan, by rules: the browser's answer when the
 * assistant cannot be asked (no model configured, or it did not answer). A piece placed before on
 * another group (a floor) goes the same way here, by the task with the same name; light fixtures in a
 * lay-in ceiling go in with its tiles; otherwise the usual build-out trade order decides: partitions,
 * rough-in, ceiling grid, what hangs from the grid, ceiling tiles, drywall, paint, floors, cleaning.
 * Pure: names in, a task id and a reason out.
 */

export interface PlacementTask {
  id: number | string;
  name: string;
  trade?: string | null;
}

export interface PlacementPrecedent {
  /** The group the piece went into before, e.g. "Level 1 build-out". */
  group: string;
  after: string;
  before: string | null;
  /** How it was tied in there: `alongside` started it with `after`; otherwise it went in after it. */
  mode?: 'alongside';
}

export interface PlacementSuggestion {
  afterId: number | string;
  beforeId: number | string | null;
  reason: string;
  source: 'model' | 'rules';
  /** False when the assistant found the piece belongs in none of the groups it was offered (the reason says why). */
  fits?: boolean;
  /** `alongside`: it starts when the task it goes after starts (a start-to-start link), and nothing in the plan moves. */
  mode?: 'alongside';
}

/** A task's name without the floor or copy it belongs to: "Ceiling grid, level 2" → "ceiling grid". */
export function baseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,–—-]\s*(level|floor|storey|story|lvl|zone|room|unit|block)\s*[\w.]+\s*$/, '')
    .replace(/\s*\((level|floor)\s*[\w.]+\)\s*$/, '')
    .replace(/\s+\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build-out stages in the order the trades follow each other; a task's stage is the first that names it. */
const STAGES: { words: RegExp; label: string }[] = [
  { words: /lay ?out|set ?out|setting out|survey/, label: 'layout' },
  { words: /frame|stud|partition/, label: 'partitions' },
  { words: /first[- ]?fix|rough[- ]?in|cabling|containment|piping|ductwork/, label: 'rough-in' },
  { words: /ceiling grid|grid/, label: 'the ceiling grid' },
  { words: /light|luminaire|fixture|diffuser|sprinkler head|smoke detector|speaker/, label: 'ceiling fixtures' },
  { words: /ceiling tile|tiles? .*ceiling/, label: 'the ceiling tiles' },
  { words: /board|drywall|tape|skim/, label: 'drywall' },
  { words: /second[- ]?fix|trim[- ]?out|socket|switch/, label: 'trim-out' },
  { words: /paint|decorat/, label: 'paint' },
  { words: /floor|carpet|vinyl|floor topping/, label: 'floor finishes' },
  { words: /clean|snag|punch/, label: 'cleaning' },
  { words: /handover|commission|test/, label: 'handover' },
];

function stageOf(name: string): number | null {
  const words = name.toLowerCase();
  const index = STAGES.findIndex((stage) => stage.words.test(words));
  return index < 0 ? null : index;
}

/**
 * Whether a group holds the kind of work a piece is part of, by the build-out trade order: light fixtures
 * belong among the partitions, rough-in, grid, tiles and paint of a floor, not in a concrete pour. Null when
 * the piece is no build-out work the order knows, so this says nothing either way.
 */
export function stageFits(piece: { name: string; tasks: readonly { name: string; days?: number }[] }, groupTaskNames: readonly string[]): boolean | null {
  if (pieceStage(piece) === null) return null;
  return groupTaskNames.some((name) => stageOf(name) !== null);
}

const NUMBER_WORDS: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8 };

/** The number a place is called by: "level 1", "floor one", "the first floor", "wing 2", "the 2nd floor". */
export function placeNumber(words: string): number | null {
  const digits = /\b(\d+)(?:st|nd|rd|th)?\b/.exec(words);
  if (digits) return Number(digits[1]);
  for (const word of words.toLowerCase().split(/[^a-z]+/)) {
    if (word in NUMBER_WORDS) return NUMBER_WORDS[word]!;
  }
  return null;
}

const LEVEL = /\b(?:level|floor|storey|story|lvl)\s+(\d+|one|two|three|four|five|six|seven|eight)\b|\b(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:floor|level|storey|story)\b/;
const AREA = /\b(wing|zone|block|building|area|unit|phase)\s+(\d+|one|two|three|four|five|six|seven|eight)\b/;

/**
 * The place a name is for, the same however it is put: "Concrete deck, level 1" and "Level 1 build-out" are
 * both "level 1", "Ground floor build-out" is "level 0", "Wing 2 fit-out" is "wing 2". Null when it names none.
 */
export function placeOf(name: string): string | null {
  const words = name.toLowerCase();
  if (/\bground[- ]floor\b/.test(words)) return 'level 0';
  const level = LEVEL.exec(words);
  if (level) {
    const number = placeNumber(level[1] ?? level[2] ?? '');
    return number === null ? null : `level ${number}`;
  }
  const area = AREA.exec(words);
  if (area) {
    const number = placeNumber(area[2] ?? '');
    return number === null ? null : `${area[1]} ${number}`;
  }
  return null;
}

/** The stage of the piece: its main work (the longest task with a stage), else its name. */
function pieceStage(piece: { name: string; tasks: readonly { name: string; days?: number }[] }): number | null {
  const staged = piece.tasks
    .map((task) => ({ stage: stageOf(task.name), days: task.days ?? 0 }))
    .filter((task): task is { stage: number; days: number } => task.stage !== null)
    .sort((a, b) => b.days - a.days);
  return staged[0]?.stage ?? stageOf(piece.name);
}

/**
 * Light fixtures in a lay-in ceiling (a ceiling grid and its tiles) go in with the tiles: the fixtures are set in the
 * grid as the tiles are laid, so they start with the tiles, nothing waits for them and nothing moves. Null for any
 * other piece, or a group without that ceiling.
 */
export function withTheTiles(piece: { name: string; tasks: readonly { name: string; days?: number }[] }, group: { name: string; tasks: readonly PlacementTask[] }): PlacementSuggestion | null {
  const stage = pieceStage(piece);
  if (stage === null || STAGES[stage]!.label !== 'ceiling fixtures') return null;
  // Lights (troffers, luminaires): diffusers, sprinkler heads and detectors are trimmed out once the tiles are in.
  const lights = /\b(light|lights|lighting|luminaires?|troffers?)\b/i;
  if (!lights.test(piece.name) && !piece.tasks.some((task) => lights.test(task.name))) return null;
  const grid = group.tasks.some((task) => STAGES[stageOf(task.name) ?? -1]?.label === 'the ceiling grid');
  const tiles = group.tasks.find((task) => STAGES[stageOf(task.name) ?? -1]?.label === 'the ceiling tiles');
  if (!grid || !tiles) return null;
  return { afterId: tiles.id, beforeId: null, reason: `In a lay-in ceiling the fixtures go in with the tiles: it starts with ${tiles.name}, and nothing moves.`, source: 'rules', mode: 'alongside' };
}

const WHY: Record<string, string> = {
  'ceiling fixtures': 'it hangs from the ceiling grid on the rough-in cabling, so it goes in after the grid and before the tiles close the ceiling',
};

export function suggestPlacement(
  piece: { name: string; tasks: readonly { name: string; days?: number }[] },
  group: { name: string; tasks: readonly PlacementTask[] },
  precedent: PlacementPrecedent | null = null,
): PlacementSuggestion | null {
  const tasks = group.tasks;
  if (tasks.length === 0) return null;
  if (precedent) {
    const at = tasks.findIndex((task) => baseName(task.name) === baseName(precedent.after));
    if (at >= 0 && precedent.mode === 'alongside') {
      return { afterId: tasks[at]!.id, beforeId: null, reason: `Placed like ${precedent.group}: with ${tasks[at]!.name}.`, source: 'rules', mode: 'alongside' };
    }
    if (at >= 0) {
      const before = precedent.before ? tasks.find((task) => baseName(task.name) === baseName(precedent.before!)) : tasks[at + 1];
      return {
        afterId: tasks[at]!.id,
        beforeId: before?.id ?? null,
        reason: `Placed like ${precedent.group}: after ${tasks[at]!.name}${before ? `, before ${before.name}` : ''}.`,
        source: 'rules',
      };
    }
  }
  const tiles = withTheTiles(piece, group);
  if (tiles) return tiles;
  const stage = pieceStage(piece);
  if (stage !== null) {
    let at = -1;
    tasks.forEach((task, index) => {
      const own = stageOf(task.name);
      if (own !== null && own < stage) at = index;
    });
    if (at >= 0) {
      // The task that waits: the nearest later trade (the ceiling tiles before the drywall), else the next task.
      const later = tasks.slice(at + 1).filter((task) => (stageOf(task.name) ?? -1) > stage);
      const nearest = later.reduce<PlacementTask | null>((best, task) => (best === null || stageOf(task.name)! < stageOf(best.name)! ? task : best), null);
      const before = nearest ?? tasks[at + 1] ?? null;
      const label = STAGES[stage]!.label;
      return {
        afterId: tasks[at]!.id,
        beforeId: before?.id ?? null,
        reason: `${piece.name} is ${label}: ${WHY[label] ?? `it follows ${tasks[at]!.name}${before ? ` and comes before ${before.name}` : ''} in the usual trade order`}.`,
        source: 'rules',
      };
    }
  }
  const last = tasks[tasks.length - 1]!;
  return { afterId: last.id, beforeId: null, reason: `Nothing in ${group.name} says otherwise, so it goes at the end, after ${last.name}.`, source: 'rules' };
}
