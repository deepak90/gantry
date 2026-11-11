/**
 * Reading the page for the 3D layer: any CSS color as a three.js color, a bar's face as Bryntum and our
 * stylesheet drew it, and clearing away what a model leaves behind.
 */
import { CanvasTexture, Color, LinearFilter, type Mesh, type MeshBasicMaterial, type Object3D, SRGBColorSpace } from 'three';

const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
probe.canvas.width = 1;
probe.canvas.height = 1;

/** Any CSS color, oklch and color-mix included, as a three.js color: the browser does the parsing. */
const parsed = new Map<string, Color>();

export function cssColor(value: string): Color {
  const known = parsed.get(value);
  if (known) return known.clone();
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  const color = new Color().setRGB((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255, SRGBColorSpace);
  if (parsed.size < 400) parsed.set(value, color.clone());
  return color;
}

export const tokenColor = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ellipsized(context: CanvasRenderingContext2D, text: string, room: number): string {
  if (context.measureText(text).width <= room) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Paints the bar's face at 3× so the block's top reads as sharply as the bar it replaces. */
export function paintFace(wrap: HTMLElement, bar: HTMLElement, rect: DOMRect): CanvasTexture {
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(4, Math.ceil(rect.width * scale));
  canvas.height = Math.max(4, Math.ceil(rect.height * scale));
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  const style = getComputedStyle(bar);
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 5;
  context.beginPath();
  context.roundRect(0, 0, rect.width, rect.height, radius);
  context.save();
  context.clip();
  context.fillStyle = style.backgroundColor;
  context.fillRect(0, 0, rect.width, rect.height);
  const percent = bar.querySelector<HTMLElement>('.b-task-percent-bar');
  if (percent) {
    const part = percent.getBoundingClientRect();
    const fill = getComputedStyle(percent).backgroundColor;
    if (part.width > 0 && fill !== 'rgba(0, 0, 0, 0)') {
      context.fillStyle = fill;
      context.fillRect(0, 0, part.width, rect.height);
    }
  }
  context.restore();
  if (wrap.classList.contains('look-status-todo')) {
    context.beginPath();
    context.roundRect(0.75, 0.75, rect.width - 1.5, rect.height - 1.5, radius);
    context.lineWidth = 1.5;
    context.strokeStyle = style.getPropertyValue('--look-phase').trim() || style.color;
    context.globalAlpha = 0.6;
    context.stroke();
    context.globalAlpha = 1;
  }
  const icon = bar.querySelector<HTMLElement>('.look-bar-icon');
  if (icon) {
    const glyph = getComputedStyle(icon, '::before');
    const box = icon.getBoundingClientRect();
    const content = glyph.content.replace(/^["']|["']$/g, '');
    if (content && content !== 'none' && box.width > 0) {
      context.font = `${glyph.fontWeight} ${glyph.fontSize} ${glyph.fontFamily}`;
      context.fillStyle = getComputedStyle(icon).color;
      context.textBaseline = 'middle';
      context.fillText(content, box.left - rect.left, box.top - rect.top + box.height / 2);
    }
  }
  const name = bar.querySelector<HTMLElement>('.look-bar-name');
  if (name) {
    const box = name.getBoundingClientRect();
    if (box.width > 0) {
      const nameStyle = getComputedStyle(name);
      context.font = `${nameStyle.fontWeight} ${nameStyle.fontSize} ${nameStyle.fontFamily}`;
      context.fillStyle = nameStyle.color;
      context.textBaseline = 'middle';
      const x = box.left - rect.left;
      context.fillText(ellipsized(context, name.textContent ?? '', rect.width - x - 6), x, box.top - rect.top + box.height / 2);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function disposeDeep(object: Object3D): void {
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.geometry && !mesh.geometry.userData.shared) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      if (material.userData.shared) continue;
      (material as MeshBasicMaterial).map?.dispose();
      material.dispose();
    }
  });
}

