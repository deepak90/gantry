/**
 * A machine's days as a calendar lying on the lot: a row a week, Monday to Sunday, the way the site office's wall
 * calendar reads. What each day is follows the day track's rule (day-track.ts), so the two always say the same thing,
 * and each day says it in a word: amber is IDLE, a day on rent with nothing to lift, with what it costs; the bar's color
 * is WORK, a planned day of work; outlined in the bar's color and hatched is COVER, a day on rent around the work on
 * purpose; gray is OFF, a day on rent inside the work with none planned (a weekend); a plain square is a day it isn't
 * on rent. The days on rent, or only the idle ones, can be made to stand out while the rest fade back. When the
 * rental's dates change, the days that change shrink away into what they are now, one after the other, earliest first.
 */
import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type BufferGeometry } from 'three';
import { dayKey, spentWords, type DayKind, type DayTile, type DayTrack, type TrackColors } from './day-track';
import { solid, within } from './parts';
import { planClock } from '../../plan-clock';

const DAY_MS = 86_400_000;
/** The weekday letters' row, as a share of a day's square. */
const HEADER = 0.5;
const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });
const FONT = '"Archivo Variable", system-ui, sans-serif';
/** A day's word: what it is, at a glance. */
const WORDS: Readonly<Record<Exclude<DayKind, 'off'>, string>> = { idle: 'IDLE', work: 'WORK', cover: 'COVER', paid: 'OFF' };

/** Which days stand out: every day on rent, or only the idle ones. */
export type CalendarEmphasis = 'span' | 'idle' | null;

export interface DayCalendar extends DayTrack {
  /** Across, Monday to Sunday, in the scene's units. */
  readonly width: number;
  /** From the weekday letters to the last week, in the scene's units. */
  readonly depth: number;
  /** The day at a point on the face (its uv); null on the weekday letters. A day off the rental reads as `off`. */
  tileAtUv(u: number, v: number): DayTile | null;
  /** The days on rent (`span`) or the idle days (`idle`) stand out and the rest fade back, by `amount` (0 to 1). */
  emphasize(mode: CalendarEmphasis, amount?: number): void;
  /** Where the squares of these kinds lie, from the face's middle, in the scene's units; null when there are none. */
  squaresOf(kinds: readonly DayKind[]): { x0: number; y0: number; x1: number; y1: number } | null;
}

const dayAfter = (at: number, days = 1): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};
/** Midnight of the Monday on or before the day. */
const mondayOf = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)).getTime();
};

interface Square {
  at: number;
  /** What the day was, and what it is becoming; undefined: not one of the rental's days. */
  from: DayTile | undefined;
  to: DayTile | undefined;
  /** Its place in the order the changing days turn over, from 0 to 1. */
  turn: number;
  /** 0 as it was, 1 as it is now. */
  done: number;
}

const changed = (a: DayTile | undefined, b: DayTile | undefined): boolean => a?.kind !== b?.kind || (a?.costMinor ?? 0) !== (b?.costMinor ?? 0);
const rented = (tile: DayTile | undefined): tile is DayTile => tile !== undefined && tile.kind !== 'off';

/**
 * `room` is the depth the lot has for it: a day's square is as large as `largest` allows while all the weeks fit.
 * `ring` outlines the idle days while they stand out.
 */
export function createDayCalendar(
  tiles: readonly DayTile[],
  colors: TrackColors,
  wholeMoney: (minor: number) => string,
  { room = 74, largest = 20, ring = colors.ink }: { room?: number; largest?: number; ring?: string } = {},
): DayCalendar {
  const group = new Group();
  const canvas = document.createElement('canvas');
  const paint = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const face = new Mesh(new PlaneGeometry(1, 1), material);
  face.position.z = 5.2;
  const baseMaterial = new MeshStandardMaterial({ color: colors.ink, roughness: 0.7 });
  let base: Mesh | null = null;
  group.add(face);

  let squares: Square[] = [];
  let first = 0;
  let weeks = 1;
  let side = largest;
  let hoverAt: number | null = null;
  let lastAt = 0;
  let drawnDay = -1;
  let emphasis: CalendarEmphasis = null;
  let emphasisAmount = 0;

  /** The weeks from the Monday of the first day to the Sunday of the last; they only ever grow while it is shown. */
  const lay = (days: readonly DayTile[]): void => {
    const known = new Map(squares.map((square) => [square.at, square]));
    const ats = [...known.keys(), ...days.map((tile) => tile.at)];
    if (ats.length === 0) ats.push(planClock.now().getTime());
    const start = mondayOf(Math.min(...ats));
    const end = mondayOf(Math.max(...ats));
    let count = 1;
    for (let at = start; at < end && count < 60; at = dayAfter(at, 7)) count += 1;
    if (start === first && count === weeks && squares.length > 0) return;
    first = start;
    weeks = count;
    const fresh: Square[] = [];
    for (let index = 0, at = start; index < weeks * 7; index += 1, at = dayAfter(at)) fresh.push(known.get(at) ?? { at, from: undefined, to: undefined, turn: 0, done: 1 });
    squares = fresh;
    side = Math.min(largest, room / (weeks + HEADER));
    const [width, depth] = [side * 7, side * (weeks + HEADER)];
    const old: BufferGeometry = face.geometry;
    face.geometry = new PlaneGeometry(width, depth);
    old.dispose();
    if (base) {
      base.removeFromParent();
      base.geometry.dispose();
    }
    base = solid(new BoxGeometry(width + 6, depth + 6, 5), baseMaterial, 0, 0, 2.5);
    group.add(base);
    const tall = Math.round((1400 * depth) / width);
    // A texture's storage on the card keeps the size it was first given: a calendar that grows a week needs new storage.
    if (canvas.height !== tall && canvas.height > 0) texture.dispose();
    canvas.width = 1400;
    canvas.height = tall;
  };

  lay(tiles);
  const byDay = new Map(tiles.map((tile) => [tile.at, tile]));
  for (const square of squares) square.from = square.to = byDay.get(square.at);

  const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
    paint.beginPath();
    paint.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  };

  /** Whether a day stands out now. */
  const standsOut = (tile: DayTile | undefined): boolean => (emphasis === 'span' ? rented(tile) : emphasis === 'idle' ? tile?.kind === 'idle' : false);

  /**
   * One day's square, `scale` of its size about its middle (it shrinks away when its day changes) and `shown` of its
   * strength, as the date `now` sees it: a day the date has reached is solid, one still to come is paler.
   */
  const drawDay = (square: Square, tile: DayTile | undefined, left: number, top: number, size: number, scale: number, shown: number, now: number): void => {
    const pad = size * 0.045;
    const full = size - pad * 2;
    const w = full * scale;
    if (w < 1 || shown <= 0.01) return;
    const [x, y] = [left + pad + (full - w) / 2, top + pad + (full - w) / 2];
    const reached = now >= square.at;
    const out = standsOut(tile);
    // What doesn't stand out fades back while something does.
    const strength = shown * (emphasis && !out ? 1 - 0.66 * emphasisAmount : 1);
    roundRect(x, y, w, w, size * 0.08 * scale);
    if (!rented(tile)) {
      paint.globalAlpha = strength;
      paint.strokeStyle = colors.off;
      paint.lineWidth = 3;
      paint.stroke();
    } else if (tile.kind === 'cover') {
      // Cover: kept on purpose, so outlined in the work's color and hatched, not filled like a day of work.
      paint.globalAlpha = strength * (reached ? 1 : 0.7);
      paint.fillStyle = colors.paper;
      paint.fill();
      paint.save();
      paint.clip();
      paint.strokeStyle = colors.bar;
      paint.globalAlpha = strength * 0.32;
      paint.lineWidth = size * 0.035;
      for (let offset = -w; offset < w * 2; offset += size * 0.15) {
        paint.beginPath();
        paint.moveTo(x + offset, y + w);
        paint.lineTo(x + offset + w, y);
        paint.stroke();
      }
      paint.restore();
      roundRect(x, y, w, w, size * 0.08 * scale);
      paint.globalAlpha = strength;
      paint.strokeStyle = colors.bar;
      paint.lineWidth = size * 0.04;
      paint.stroke();
    } else {
      paint.globalAlpha = strength * (reached ? 1 : 0.5);
      paint.fillStyle = tile.kind === 'idle' ? colors.idle : tile.kind === 'work' ? colors.bar : colors.off;
      paint.fill();
    }
    if (out && emphasisAmount > 0) {
      roundRect(x - size * 0.02, y - size * 0.02, w + size * 0.04, w + size * 0.04, size * 0.1 * scale);
      paint.globalAlpha = shown * emphasisAmount;
      paint.strokeStyle = emphasis === 'idle' ? ring : colors.ink;
      paint.lineWidth = size * (emphasis === 'idle' ? 0.06 : 0.045);
      paint.stroke();
    }
    paint.globalAlpha = 1;
    if (scale < 0.72) return;
    paint.save();
    roundRect(x, y, w, w, size * 0.08 * scale);
    paint.clip();
    const date = new Date(square.at);
    const onWork = tile?.kind === 'work' && reached;
    const ink = onWork ? colors.paper : colors.ink;
    paint.fillStyle = rented(tile) ? ink : colors.soft;
    paint.globalAlpha = strength * (rented(tile) ? (reached ? 1 : 0.78) : 0.55);
    const named = date.getDate() === 1 || square.at === first;
    paint.font = `780 ${Math.round(size * (named ? 0.24 : 0.3) * scale)}px ${FONT}`;
    paint.fillText(named ? `${MONTH.format(date)} ${date.getDate()}` : String(date.getDate()), x + size * 0.08 * scale, y + size * 0.34 * scale, w - size * 0.12);
    if (rented(tile)) {
      if (tile.costMinor > 0) {
        paint.font = `640 ${Math.round(size * 0.15 * scale)}px ${FONT}`;
        paint.fillText(spentWords(wholeMoney(tile.costMinor)), x + size * 0.08 * scale, y + size * 0.58 * scale, w - size * 0.12);
      }
      const big = out && emphasis === 'idle' ? 1 + 0.16 * emphasisAmount : 1;
      paint.font = `850 ${Math.round(size * 0.21 * big * scale)}px ${FONT}`;
      paint.fillStyle = tile.kind === 'cover' ? colors.bar : ink;
      paint.fillText(WORDS[tile.kind as Exclude<DayKind, 'off'>], x + size * 0.08 * scale, y + w - size * 0.11 * scale, w - size * 0.12);
    }
    paint.restore();
    paint.globalAlpha = 1;
  };

  const draw = (now: number): void => {
    const [W, H] = [canvas.width, canvas.height];
    const size = W / 7;
    const head = size * HEADER;
    paint.globalAlpha = 1;
    paint.fillStyle = colors.paper;
    paint.fillRect(0, 0, W, H);
    paint.textBaseline = 'middle';
    paint.textAlign = 'center';
    paint.fillStyle = colors.soft;
    paint.font = `700 ${Math.round(head * 0.52)}px ${FONT}`;
    LETTERS.forEach((letter, column) => paint.fillText(letter, size * (column + 0.5), head * 0.56));
    paint.textAlign = 'left';
    paint.textBaseline = 'alphabetic';
    const today = squares.find((square) => now >= square.at && now < square.at + DAY_MS)?.at ?? null;
    squares.forEach((square, index) => {
      const [left, top] = [(index % 7) * size, head + Math.floor(index / 7) * size];
      if (square.from === square.to || square.done >= 1) drawDay(square, square.to, left, top, size, 1, 1, now);
      else {
        // Changing: what it is now comes in where it stands, and what it was shrinks away into it.
        const eased = square.done * square.done * (3 - 2 * square.done);
        drawDay(square, square.to, left, top, size, 1, eased, now);
        drawDay(square, square.from, left, top, size, 1 - eased, 1, now);
      }
      if (square.at === today || square.at === hoverAt) {
        paint.globalAlpha = square.at === today ? 1 : 0.5;
        paint.strokeStyle = colors.ink;
        paint.lineWidth = square.at === today ? 10 : 6;
        roundRect(left + 5, top + 5, size - 10, size - 10, size * 0.09);
        paint.stroke();
        paint.globalAlpha = 1;
      }
    });
    texture.needsUpdate = true;
  };

  /** The day at a point on the face; a day off the rental reads as `off`. */
  const dayAtUv = (u: number, v: number): DayTile | null => {
    const down = (1 - v) * (weeks + HEADER) - HEADER;
    if (down < 0 || u < 0 || u >= 1) return null;
    const square = squares[Math.floor(down) * 7 + Math.floor(u * 7)];
    if (!square) return null;
    return square.to ?? { at: square.at, kind: 'off', costMinor: 0 };
  };

  /** A square's middle on the face, from the face's own middle. */
  const middleOf = (index: number): { x: number; y: number } => {
    const [width, depth] = [side * 7, side * (weeks + HEADER)];
    return { x: -width / 2 + ((index % 7) + 0.5) * side, y: depth / 2 - (HEADER + Math.floor(index / 7) + 0.5) * side };
  };

  return {
    group,
    face,
    get width() {
      return side * 7;
    },
    get depth() {
      return side * (weeks + HEADER);
    },
    idleAnchor() {
      const from = squares.findIndex((square) => square.to?.kind === 'idle');
      if (from < 0) return null;
      let to = from;
      while (squares[to + 1]?.to?.kind === 'idle') to += 1;
      const [a, b] = [middleOf(from), middleOf(to)];
      return new Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, 22);
    },
    update(at) {
      lastAt = at;
      const day = dayKey(at);
      if (day !== drawnDay) {
        drawnDay = day;
        draw(at);
      }
    },
    tileX(at) {
      const index = squares.findIndex((square) => square.at === at);
      return index < 0 ? null : middleOf(index).x;
    },
    tileAt(along) {
      // Along the first week, for a caller that only knows one way across.
      return dayAtUv(along, 1 - (HEADER + 0.5) / (weeks + HEADER));
    },
    tileAtUv: dayAtUv,
    setHover(at) {
      if (at === hoverAt) return;
      hoverAt = at;
      draw(lastAt);
    },
    setDays(next) {
      lay(next);
      const now = new Map(next.map((tile) => [tile.at, tile]));
      for (const square of squares) {
        // From what shows now, even part way through changing.
        const showing = square.done < 0.5 ? square.from : square.to;
        const coming = now.get(square.at);
        if (changed(showing, coming)) Object.assign(square, { from: showing, to: coming, done: 0 });
        else Object.assign(square, { from: coming, to: coming, done: 1 });
      }
      // Earliest first: the days change one after the other, not all at once.
      const changing = squares.filter((square) => square.from !== square.to);
      changing.forEach((square, index) => {
        square.turn = changing.length > 1 ? index / (changing.length - 1) : 0;
      });
      draw(lastAt);
    },
    morph(t) {
      for (const square of squares) {
        if (square.from === square.to) continue;
        square.done = within(t, square.turn * 0.55, square.turn * 0.55 + 0.45);
        if (t >= 1) {
          square.done = 1;
          square.from = square.to;
        }
      }
      draw(lastAt);
    },
    emphasize(mode, amount = 1) {
      const next = mode === null ? 0 : Math.min(1, Math.max(0, amount));
      if (mode === emphasis && next === emphasisAmount) return;
      emphasis = mode;
      emphasisAmount = next;
      draw(lastAt);
    },
    squaresOf(kinds) {
      let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
      squares.forEach((square, index) => {
        const kind = square.to?.kind ?? 'off';
        if (!kinds.includes(kind)) return;
        const { x, y } = middleOf(index);
        const half = side / 2;
        box = box ? { x0: Math.min(box.x0, x - half), y0: Math.min(box.y0, y - half), x1: Math.max(box.x1, x + half), y1: Math.max(box.y1, y + half) } : { x0: x - half, y0: y - half, x1: x + half, y1: y + half };
      });
      return box;
    },
  };
}
