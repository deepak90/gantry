/**
 * Who is where on a piece of work: the floor shared out between its firms by how many people each has there, each
 * with its logo on the ground and its number of people beside it, and one figure standing there for each person.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';

export interface Zone {
  /** Its center across the plot, with the plot's center at 0. */
  x: number;
  w: number;
}

/** The floor shared by headcount, with each firm getting enough room to stand its logo on. */
export function crewZones(people: readonly number[], width: number, least = 70): Zone[] {
  const everyone = people.reduce((sum, count) => sum + Math.max(1, count), 0);
  if (everyone === 0) return [];
  const floorShare = least * people.length <= width ? least : width / people.length;
  const spare = width - floorShare * people.length;
  let left = -width / 2;
  return people.map((count) => {
    const w = floorShare + (spare * Math.max(1, count)) / everyone;
    const zone = { x: left + w / 2, w };
    left += w;
    return zone;
  });
}

/** Where this many people stand in an area: in even rows, as wide as the area allows. */
export function standingSpots(count: number, area: { x: number; y: number; w: number; d: number }): { x: number; y: number }[] {
  if (count <= 0) return [];
  const across = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * area.w) / Math.max(1, area.d)))));
  const rows = Math.ceil(count / across);
  const spots: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const inRow = row === rows - 1 ? count - across * (rows - 1) : across;
    for (let index = 0; index < inRow; index++) {
      spots.push({ x: area.x + ((index + 0.5) / inRow - 0.5) * area.w, y: area.y + ((row + 0.5) / rows - 0.5) * area.d });
    }
  }
  return spots;
}

export interface CrewMark {
  name: string;
  color: string;
  /** The firm's logo if it has one, as a picture. */
  image?: string | undefined;
  /** Otherwise its icon on the chart, as a CSS class. */
  icon: string;
  people: number;
  /** Set when the plan has not said how many, and this is the usual size for the trade. */
  usual: boolean;
}

// Reading a glyph off the page makes the browser work out its styles: once for each icon is plenty.
const glyphs = new Map<string, { text: string; font: string } | null>();

function glyphOf(icon: string): { text: string; font: string } | null {
  const known = glyphs.get(icon);
  if (known !== undefined) return known;
  const glyph = readGlyph(icon);
  glyphs.set(icon, glyph);
  return glyph;
}

function readGlyph(icon: string): { text: string; font: string } | null {
  const probe = document.createElement('i');
  probe.className = icon;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const style = getComputedStyle(probe, '::before');
  const text = style.content.replace(/^["']|["']$/g, '');
  const font = `${style.fontWeight} ${style.fontFamily}`;
  probe.remove();
  return text && text !== 'none' ? { text, font } : null;
}

const PIXELS = 4;

/** What is painted on the ground: the logo in its square, the number of people, and the firm's name. */
export function paintCrewMark(mark: CrewMark, width: number, height: number, colors: { ink: string; soft: string; paper: string }): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * PIXELS);
  canvas.height = Math.round(height * PIXELS);
  const paint = canvas.getContext('2d')!;
  const [w, h] = [canvas.width, canvas.height];
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  const round = (x: number, y: number, across: number, down: number, radius: number): void => {
    paint.beginPath();
    paint.roundRect(x, y, across, down, radius);
  };
  paint.fillStyle = colors.paper;
  round(0, 0, w, h, h * 0.14);
  paint.fill();
  const inset = h * 0.1;
  const square = h - inset * 2;
  paint.fillStyle = mark.color;
  round(inset, inset, square, square, h * 0.12);
  paint.fill();
  const glyph = glyphOf(mark.icon);
  if (glyph) {
    paint.fillStyle = '#ffffff';
    paint.font = `${glyph.font.split(' ')[0]} ${square * 0.56}px ${glyph.font.split(' ').slice(1).join(' ')}`;
    paint.textAlign = 'center';
    paint.textBaseline = 'middle';
    paint.fillText(glyph.text, inset + square / 2, inset + square / 2);
    paint.textAlign = 'left';
  }
  if (mark.image) {
    const picture = new Image();
    // A logo is its own colors on nothing, so it goes on the paper; until it loads, or if it does not, the icon stays.
    picture.onload = () => {
      paint.fillStyle = colors.paper;
      round(inset, inset, square, square, h * 0.12);
      paint.fill();
      paint.drawImage(picture, inset, inset, square, square);
      texture.needsUpdate = true;
    };
    picture.src = mark.image;
  }
  const textX = inset * 2 + square;
  const room = w - textX - inset;
  paint.textBaseline = 'alphabetic';
  paint.fillStyle = colors.ink;
  paint.font = `780 ${h * 0.46}px "Archivo Variable", system-ui, sans-serif`;
  const count = String(mark.people);
  paint.fillText(count, textX, h * 0.52, room);
  const countWidth = Math.min(room, paint.measureText(count).width);
  paint.font = `560 ${h * 0.2}px "Archivo Variable", system-ui, sans-serif`;
  paint.fillStyle = colors.soft;
  paint.fillText(`${mark.people === 1 ? 'person' : 'people'}${mark.usual ? ' (usual size)' : ''}`, textX + countWidth + h * 0.06, h * 0.52, Math.max(1, room - countWidth - h * 0.06));
  paint.fillStyle = colors.ink;
  paint.font = `600 ${h * 0.2}px "Archivo Variable", system-ui, sans-serif`;
  paint.fillText(mark.name, textX, h * 0.82, room);
  texture.needsUpdate = true;
  return texture;
}
