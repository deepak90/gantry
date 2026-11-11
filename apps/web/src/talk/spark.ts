/**
 * The spark button's motion helpers: speeding its endless motions up or down without a jump, and a
 * burst of little sparks when it is pressed.
 */

import { SPARK_PATH } from '../assistant/RemyMark';

/** The four-point spark, as an SVG path on a 24 by 24 box: Remy's own. */
export { SPARK_PATH };

const SPARK_COLORS = ['oklch(0.98 0.012 250)', 'oklch(0.88 0.07 232)', 'oklch(0.85 0.15 78)', 'oklch(0.62 0.19 262)'];

/**
 * Eases an element's endless animations (and its children's) to `rate` times their speed. Changing the
 * playback rate keeps every animation where it is, so the light speeds up rather than jumping.
 */
export function rampTo(element: HTMLElement, rate: number, overMs = 380): void {
  if (typeof element.getAnimations !== 'function') return;
  const animations = element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations === Infinity);
  const from = animations.map((animation) => animation.playbackRate);
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / overMs);
    const eased = 1 - (1 - t) ** 3;
    animations.forEach((animation, index) => animation.updatePlaybackRate(from[index]! + (rate - from[index]!) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Throws a dozen little sparks out of `from` (inside `host`), which fade as they fly. */
export function throwSparks(host: HTMLElement, from: Element): void {
  const box = host.getBoundingClientRect();
  const at = from.getBoundingClientRect();
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 26 + Math.random() * 34;
    const bit = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bit.setAttribute('viewBox', '0 0 24 24');
    bit.setAttribute('class', 'talk-spark-bit');
    bit.setAttribute('aria-hidden', 'true');
    bit.innerHTML = `<path d="${SPARK_PATH}"/>`;
    bit.style.setProperty('--x', `${at.left - box.left + at.width / 2}px`);
    bit.style.setProperty('--y', `${at.top - box.top + at.height / 2}px`);
    bit.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    bit.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    bit.style.setProperty('--r', `${(Math.random() - 0.5) * 240}deg`);
    bit.style.setProperty('--c', SPARK_COLORS[index % SPARK_COLORS.length]!);
    host.append(bit);
    setTimeout(() => bit.remove(), 800);
  }
}
