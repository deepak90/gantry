/**
 * One piece of work, day by day, as the plan has it: every day its machine is booked and its crew is planned on the
 * job, as a row of tiles along the front of its room. A rental is paid for every day, weekends too. Amber is a day the
 * machine is booked with no work planned for it, before the work or after it, and says what it costs, as money going
 * out. A day of cover around the work, and a day off inside it, cost the same but aren't idle: one is on purpose, and no
 * new dates take the other away, so each says what it costs without being called idle. The bar's color is a planned day of work: the plan says which days, not how much gets done on each, so a day
 * never claims a share of the work.
 * The rule for the board's strip and the room's track is the same, so the two always say the same thing.
 */
import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';
import { solid, within } from './parts';

const DAY_MS = 86_400_000;

export type DayKind = 'idle' | 'cover' | 'work' | 'paid' | 'off';

export interface DayTile {
  /** Midnight of the day. */
  at: number;
  kind: DayKind;
  /** What the machine costs on this day with no work for it (idle or paid); 0 when it costs nothing or the viewer may not see money. */
  costMinor: number;
}

/** Which day a moment is in, where this person is: days turn at their midnight, not at Greenwich's. */
export const dayKey = (at: number): number => {
  const date = new Date(at);
  return date.getFullYear() * 372 + date.getMonth() * 31 + date.getDate();
};

const NARROW_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'narrow' });

const nextDay = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
};

/** Every calendar day from the machine's first booked day to the last day anyone is planned here. A day on rent with no work planned is idle on either side of the work, and paid inside it. */
export function dayTiles(facts: { rulerStart: Date; rulerEnd: Date; start: Date; end: Date; workDays: readonly number[]; rentedDays: readonly number[]; coverOnly?: boolean }, dailyRateMinor: number): DayTile[] {
  const tiles: DayTile[] = [];
  const first = new Date(facts.rulerStart.getFullYear(), facts.rulerStart.getMonth(), facts.rulerStart.getDate()).getTime();
  const end = facts.end.getTime();
  const startDay = new Date(facts.start.getFullYear(), facts.start.getMonth(), facts.start.getDate()).getTime();
  const working = new Set(facts.workDays);
  const rented = new Set(facts.rentedDays);
  for (let at = first; at < facts.rulerEnd.getTime(); at = nextDay(at)) {
    const inWork = at >= startDay && at < end;
    if (inWork && working.has(at)) tiles.push({ at, kind: 'work', costMinor: 0 });
    else if (!rented.has(at)) tiles.push({ at, kind: 'off', costMinor: 0 });
    else tiles.push({ at, kind: inWork ? 'paid' : facts.coverOnly ? 'cover' : 'idle', costMinor: dailyRateMinor });
  }
  return tiles;
}

/** What the machine's idle days come to by this date. A rental is billed by the day, so a day counts in full once it has begun, and the last one reaches the total. */
export function idleCostBy(tiles: readonly DayTile[], at: number): number {
  return tiles.reduce((sum, tile) => (tile.kind === 'idle' && at >= tile.at ? sum + tile.costMinor : sum), 0);
}

/** The counts behind "work planned on 6 of 15 booked days". */
export function rentalUse(tiles: readonly DayTile[]): { idle: number; work: number; paid: number; cover: number; booked: number; share: number } {
  const count = (kind: DayKind): number => tiles.filter((tile) => tile.kind === kind).length;
  const [idle, work, paid, cover] = [count('idle'), count('work'), count('paid'), count('cover')];
  const booked = idle + work + paid + cover;
  return { idle, work, paid, cover, booked, share: booked > 0 ? work / booked : 0 };
}

/** Money going out: a true minus sign, so it cannot be read as money saved or money in hand. */
export const spentWords = (money: string): string => `\u2212${money}`;

export interface TrackColors {
  bar: string;
  idle: string;
  ink: string;
  soft: string;
  paper: string;
  off: string;
}

export interface DayTrack {
  group: Group;
  /** What the pointer finds: a click on a day takes the date there. */
  face: Mesh;
  /** Where the idle stretch is, along the track, for a label to point at; null with no idle days. */
  idleAnchor(): Vector3 | null;
  /** Follows the date. */
  update(at: number): void;
  /** Where a day's tile is along the track, or null if the track has no such day. */
  tileX(at: number): number | null;
  /** The day at this far along the track, from 0 to 1. */
  tileAt(along: number): DayTile | null;
  /** Outlines the day under the pointer. */
  setHover(at: number | null): void;
  /** Takes on new days. Days that went close up and those that stay widen to fill the track, as `morph` runs from 0 to 1. */
  setDays(next: readonly DayTile[]): void;
  morph(t: number): void;
}

/** How many of the planned work days have begun, as a share. What a machine costs by the day follows this; the work itself need not. */
export function workDaysBegun(tiles: readonly DayTile[], at: number): number {
  const work = tiles.filter((tile) => tile.kind === 'work');
  return work.length === 0 ? 0 : work.filter((tile) => tile.at <= at).length / work.length;
}

/** A day in words, for the label over its tile. */
export function dayWords(tile: DayTile, tiles: readonly DayTile[], machine: string | null, money: (minor: number) => string): string {
  const date = new Date(tile.at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const name = machine ?? 'Machine';
  switch (tile.kind) {
    case 'idle':
      return `${date}: ${name} booked, no work planned${tile.costMinor > 0 ? `, ${spentWords(money(tile.costMinor))}` : ''}`;
    case 'work': {
      const work = tiles.filter((item) => item.kind === 'work');
      const day = work.findIndex((item) => item.at === tile.at) + 1;
      return `${date}: planned day ${day} of ${work.length}`;
    }
    case 'cover':
      return `${date}: ${name} booked as cover${tile.costMinor > 0 ? `, ${spentWords(money(tile.costMinor))}` : ''}`;
    case 'paid':
      return `${date}: crew off, ${name} still booked${tile.costMinor > 0 ? `, ${spentWords(money(tile.costMinor))}` : ''}`;
    default:
      return `${date}: day off`;
  }
}

const TRACK_D = 44;

export function createDayTrack(tiles: readonly DayTile[], width: number, y: number, colors: TrackColors, wholeMoney: (minor: number) => string): DayTrack {
  const group = new Group();
  group.position.y = y;
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = Math.round((2048 * TRACK_D) / width);
  const paint = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new Mesh(new PlaneGeometry(width, TRACK_D), new MeshBasicMaterial({ map: texture, toneMapped: false }));
  face.position.z = 5.2;
  group.add(face);

  // A tile's share of the track is its weight: all 1 at rest, and moving between 0 and 1 while the days change.
  let slots: { tile: DayTile; weight: number; from: number; to: number; turn: number }[] = tiles.map((tile) => ({ tile, weight: 1, from: 1, to: 1, turn: 0 }));
  const totalWeight = (): number => Math.max(0.001, slots.reduce((sum, slot) => sum + slot.weight, 0));
  let hoverAt: number | null = null;
  let lastAt = 0;
  let drawnDay = -1;

  const draw = (at: number): void => {
    const unit = canvas.width / totalWeight();
    const h = canvas.height;
    paint.fillStyle = colors.paper;
    paint.fillRect(0, 0, canvas.width, h);
    paint.textBaseline = 'alphabetic';
    let x = 0;
    for (const { tile, weight } of slots) {
      const scale = weight * unit;
      const left = x;
      x += scale;
      if (scale < 1) continue;
      const passed = at >= tile.at + DAY_MS;
      const today = at >= tile.at && at < tile.at + DAY_MS;
      paint.save();
      // Nothing a tile draws may reach its neighbors.
      paint.beginPath();
      paint.rect(left + 2, 2, scale - 4, h - 4);
      paint.clip();
      paint.globalAlpha = passed || today ? 1 : 0.46;
      paint.fillStyle = tile.kind === 'idle' ? colors.idle : tile.kind === 'work' ? colors.bar : colors.off;
      paint.fillRect(left, 0, scale, h);
      paint.globalAlpha = passed || today ? 1 : 0.7;
      // A work day ahead of the date is pale, and light words would disappear on it.
      paint.fillStyle = tile.kind === 'work' && (passed || today) ? colors.paper : colors.ink;
      const date = new Date(tile.at);
      if (scale >= 40) {
        paint.font = `640 ${Math.round(Math.min(h * 0.22, scale * 0.24))}px "Archivo Variable", system-ui, sans-serif`;
        paint.fillText(NARROW_DAY.format(date), left + 10, h * 0.28, scale - 14);
        paint.font = `780 ${Math.round(Math.min(h * 0.36, scale * 0.46))}px "Archivo Variable", system-ui, sans-serif`;
        paint.fillText(String(date.getDate()), left + 10, h * 0.64, scale - 14);
      }
      if (scale >= 72) {
        paint.font = `800 ${Math.round(Math.min(h * 0.26, scale * 0.31))}px "Archivo Variable", system-ui, sans-serif`;
        // Money going out, in so many words; without the money it still says what the day was.
        if (tile.kind === 'idle') paint.fillText(tile.costMinor > 0 ? spentWords(wholeMoney(tile.costMinor)) : 'Idle', left + 10, h * 0.92, scale - 16);
        if ((tile.kind === 'paid' || tile.kind === 'cover') && tile.costMinor > 0) paint.fillText(spentWords(wholeMoney(tile.costMinor)), left + 10, h * 0.92, scale - 16);
        // That work is planned on this day, whichever side of the date it falls.
        if (tile.kind === 'work') paint.fillText('Work', left + 10, h * 0.92, scale - 16);
      }
      paint.restore();
      if (today || hoverAt === tile.at) {
        paint.globalAlpha = today ? 1 : 0.5;
        paint.strokeStyle = colors.ink;
        paint.lineWidth = today ? 8 : 5;
        paint.strokeRect(left + 4, 4, scale - 8, h - 8);
      }
    }
    paint.globalAlpha = 1;
    texture.needsUpdate = true;
  };

  // The base it is printed on.
  group.add(solid(new BoxGeometry(width + 6, TRACK_D + 6, 5), new MeshStandardMaterial({ color: colors.ink, roughness: 0.7 }), 0, 0, 2.5));

  const middleOf = (at: number): number | null => {
    let x = 0;
    const unit = width / totalWeight();
    for (const slot of slots) {
      if (slot.tile.at === at) return x + (slot.weight * unit) / 2 - width / 2;
      x += slot.weight * unit;
    }
    return null;
  };

  return {
    group,
    face,
    idleAnchor() {
      // The first run of idle days: a rental can have another after the work, and between them is the work.
      const live = slots.filter((slot) => slot.to > 0);
      const from = live.findIndex((slot) => slot.tile.kind === 'idle');
      if (from < 0) return null;
      const stop = live.findIndex((slot, index) => index > from && slot.tile.kind === 'work');
      const idle = live.slice(from, stop < 0 ? live.length : stop).filter((slot) => slot.tile.kind === 'idle');
      const [first, last] = [idle[0], idle[idle.length - 1]];
      if (!first || !last) return null;
      return new Vector3(((middleOf(first.tile.at) ?? 0) + (middleOf(last.tile.at) ?? 0)) / 2, y, 22);
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
      return middleOf(at);
    },
    tileAt(along) {
      let x = 0;
      const unit = 1 / totalWeight();
      for (const slot of slots) {
        x += slot.weight * unit;
        if (along < x && slot.weight > 0) return slot.tile;
      }
      return slots[slots.length - 1]?.tile ?? null;
    },
    setHover(at) {
      if (at === hoverAt) return;
      hoverAt = at;
      draw(lastAt);
    },
    setDays(next) {
      const nextAt = new Map(next.map((tile) => [tile.at, tile]));
      const known = new Map(slots.map((slot) => [slot.tile.at, slot]));
      const union = [...new Set([...known.keys(), ...nextAt.keys()])].sort((a, b) => a - b);
      slots = union.map((at) => {
        const was = known.get(at);
        const now = nextAt.get(at);
        return { tile: now ?? was!.tile, weight: was?.weight ?? 0, from: was?.weight ?? 0, to: now ? 1 : 0, turn: 0 };
      });
      // Earliest first: the days go one after the other, not all at once.
      const changing = slots.filter((slot) => slot.from !== slot.to);
      changing.forEach((slot, index) => {
        slot.turn = changing.length > 1 ? index / (changing.length - 1) : 0;
      });
    },
    morph(t) {
      for (const slot of slots) {
        const own = within(t, slot.turn * 0.55, slot.turn * 0.55 + 0.45);
        const eased = own * own * (3 - 2 * own);
        slot.weight = slot.from + (slot.to - slot.from) * eased;
      }
      if (t >= 1) {
        slots = slots.filter((slot) => slot.to > 0);
        for (const slot of slots) {
          slot.weight = 1;
          slot.from = 1;
        }
      }
      draw(lastAt);
    },
  };
}

/** The strip on the board: amber, one tick a day, saying how long and how much. */
export function paintIdleStrip(days: number, label: string, length: number, depth: number, colors: { idle: string; ink: string }): CanvasTexture {
  const canvas = document.createElement('canvas');
  const scale = 4;
  canvas.width = Math.max(16, Math.round(length * scale));
  canvas.height = Math.round(depth * scale);
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = colors.idle;
  paint.fillRect(0, 0, canvas.width, canvas.height);
  paint.fillStyle = colors.ink;
  const step = canvas.width / Math.max(1, days);
  for (let day = 1; day < days; day++) paint.fillRect(day * step - 1, canvas.height * 0.68, 2, canvas.height * 0.32);
  paint.textBaseline = 'middle';
  paint.font = `640 ${Math.round(canvas.height * 0.42)}px "Archivo Variable", system-ui, sans-serif`;
  paint.fillText(label, 8, canvas.height * 0.36, canvas.width - 14);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** The slack strip on the board: pale, hatched, and saying how many days. */
export function paintSlack(days: number, length: number, depth: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  const scale = 4;
  canvas.width = Math.max(16, Math.round(length * scale));
  canvas.height = Math.round(depth * scale);
  const paint = canvas.getContext('2d')!;
  paint.fillStyle = '#eef0f2';
  paint.fillRect(0, 0, canvas.width, canvas.height);
  paint.strokeStyle = '#c3c9d0';
  paint.lineWidth = 3;
  for (let x = -canvas.height; x < canvas.width; x += 14) {
    paint.beginPath();
    paint.moveTo(x, canvas.height);
    paint.lineTo(x + canvas.height, 0);
    paint.stroke();
  }
  paint.fillStyle = '#20262e';
  paint.textBaseline = 'middle';
  paint.font = `640 ${Math.round(canvas.height * 0.4)}px "Archivo Variable", system-ui, sans-serif`;
  paint.fillText(`${days}d slack`, 6, canvas.height * 0.5, canvas.width - 10);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
