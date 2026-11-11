/**
 * Remy's mark: the spark in an open ring. On the breath of the Talk to Remy button the ring rocks a little and the
 * spark turns; while Remy works, the ring goes round. A still mark holds its pose until someone points at it.
 *
 * One drawing serves both the React parts of the page (`RemyMark`) and the parts drawn without React,
 * such as the 3D view (`remyMarkElement`).
 */
import { useId, useMemo } from 'react';
import '../styles/remy.css';

/** The four-point spark, in a 24 by 24 box. The Talk to Remy button wears it too. */
export const SPARK_PATH = 'M12 1.5C12.7 7.2 16.8 11.3 22.5 12 16.8 12.7 12.7 16.8 12 22.5 11.3 16.8 7.2 12.7 1.5 12 7.2 11.3 11.3 7.2 12 1.5Z';

/** Still where marks sit side by side, breathing where Remy is present, working while Remy works. */
export type MarkMotion = 'still' | 'breath' | 'work';

const DEEP = 'oklch(0.42 0.16 264)';

const gradient = (id: string, stops: [number, string][]): string =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">${stops.map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`).join('')}</linearGradient>`;

/** The ring and the spark, in a 120 by 120 box. `id` keeps its gradients apart from the other marks on the page. */
export function markDrawing(id: string): string {
  const fill = (name: string) => `url(#${id}-${name})`;
  return [
    '<defs>',
    gradient(`${id}-cobalt`, [[0, 'oklch(0.8 0.11 240)'], [0.5, 'oklch(0.62 0.19 262)'], [1, DEEP]]),
    gradient(`${id}-spark`, [[0, 'oklch(0.86 0.09 235)'], [0.5, 'oklch(0.68 0.16 252)'], [1, 'oklch(0.5 0.18 262)']]),
    '</defs>',
    `<path class="remy-ring" d="M60 16 A44 44 0 1 0 104 60" stroke="${fill('cobalt')}" stroke-width="9" fill="none" stroke-linecap="round"/>`,
    `<g class="remy-spark"><path d="${SPARK_PATH}" fill="${fill('spark')}" transform="translate(32 32) scale(2.3333)"/></g>`,
  ].join('');
}

const markClass = (motion: MarkMotion, className?: string) => `remy-mark is-${motion}${className ? ` ${className}` : ''}`;

export function RemyMark({ motion = 'still', className }: { motion?: MarkMotion; className?: string }) {
  const id = `remy-${useId().replace(/[^\w-]/g, '')}`;
  const drawing = useMemo(() => ({ __html: markDrawing(id) }), [id]);
  return <svg className={markClass(motion, className)} viewBox="0 0 120 120" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={drawing} />;
}

let drawn = 0;

/** The mark as an element, for the parts of the page drawn without React. */
export function remyMarkElement(motion: MarkMotion = 'still', className?: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', markClass(motion, className));
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  drawn += 1;
  svg.innerHTML = markDrawing(`remy-dom-${drawn}`);
  return svg;
}
