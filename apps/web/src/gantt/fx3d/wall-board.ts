/**
 * A painted board: words and small bars on a wall, repainted when the date or the lens changes. The site board's
 * date and a room's story are both one of these, so what is on the wall is always what is true on this date.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

export type BoardRow =
  | { kind: 'title'; text: string }
  | { kind: 'line'; text: string; tone?: 'danger' | 'caution' | 'quiet' }
  | { kind: 'bar'; label: string; value: string; share: number; color: string; marker?: number }
  | { kind: 'dot'; color: string; text: string; note?: string };

export interface WallBoardColors {
  ink: string;
  soft: string;
  track: string;
  danger: string;
  caution: string;
}

export interface WallBoard {
  mesh: Mesh;
  draw(rows: readonly BoardRow[]): void;
}

const FONT = '"Archivo Variable", system-ui, sans-serif';

/** A board of this size on a wall. It is transparent but for what is painted on it, so the wall shows through. */
export function createWallBoard(width: number, height: number, colors: WallBoardColors, pixelsWide = 1024, lettering = 1): WallBoard {
  const canvas = document.createElement('canvas');
  canvas.width = pixelsWide;
  canvas.height = Math.round((pixelsWide * height) / width);
  const paint = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false }));
  const scale = (pixelsWide / 1024) * lettering;

  return {
    mesh,
    draw(rows) {
      paint.clearRect(0, 0, canvas.width, canvas.height);
      paint.textBaseline = 'alphabetic';
      let y = 0;
      const right = canvas.width - 8 * scale;
      for (const row of rows) {
        if (row.kind === 'title') {
          y += 46 * scale;
          paint.fillStyle = colors.ink;
          paint.font = `720 ${44 * scale}px ${FONT}`;
          paint.fillText(row.text, 8 * scale, y, right);
          y += 16 * scale;
        } else if (row.kind === 'line') {
          y += 40 * scale;
          paint.fillStyle = row.tone === 'danger' ? colors.danger : row.tone === 'caution' ? colors.ink : row.tone === 'quiet' ? colors.soft : colors.ink;
          paint.font = `${row.tone === 'quiet' ? 480 : 560} ${33 * scale}px ${FONT}`;
          if (row.tone === 'caution' || row.tone === 'danger') {
            paint.fillStyle = row.tone === 'danger' ? colors.danger : colors.caution;
            paint.fillRect(8 * scale, y - 25 * scale, 22 * scale, 22 * scale);
            paint.fillStyle = colors.ink;
            paint.fillText(row.text, 42 * scale, y, right - 34 * scale);
          } else {
            paint.fillText(row.text, 8 * scale, y, right);
          }
          y += 8 * scale;
        } else if (row.kind === 'dot') {
          y += 42 * scale;
          paint.fillStyle = row.color;
          paint.beginPath();
          paint.arc(21 * scale, y - 11 * scale, 12 * scale, 0, Math.PI * 2);
          paint.fill();
          paint.fillStyle = colors.ink;
          paint.font = `600 ${33 * scale}px ${FONT}`;
          paint.fillText(row.text, 44 * scale, y, canvas.width * 0.62);
          if (row.note) {
            paint.fillStyle = colors.soft;
            paint.font = `480 ${28 * scale}px ${FONT}`;
            paint.textAlign = 'right';
            paint.fillText(row.note, right, y, canvas.width * 0.34);
            paint.textAlign = 'left';
          }
          y += 8 * scale;
        } else {
          y += 36 * scale;
          paint.fillStyle = colors.soft;
          paint.font = `520 ${28 * scale}px ${FONT}`;
          paint.fillText(row.label, 8 * scale, y, canvas.width * 0.6);
          paint.fillStyle = colors.ink;
          paint.font = `680 ${30 * scale}px ${FONT}`;
          paint.textAlign = 'right';
          paint.fillText(row.value, right, y, canvas.width * 0.5);
          paint.textAlign = 'left';
          y += 10 * scale;
          const [barW, barH] = [right - 8 * scale, 16 * scale];
          paint.fillStyle = colors.track;
          paint.fillRect(8 * scale, y, barW, barH);
          paint.fillStyle = row.color;
          paint.fillRect(8 * scale, y, barW * Math.min(1, Math.max(0, row.share)), barH);
          if (row.marker !== undefined) {
            paint.fillStyle = colors.ink;
            paint.fillRect(8 * scale + barW * Math.min(1, Math.max(0, row.marker)) - 2 * scale, y - 4 * scale, 4 * scale, barH + 8 * scale);
          }
          y += barH + 4 * scale;
        }
      }
      texture.needsUpdate = true;
    },
  };
}
