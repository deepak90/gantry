/**
 * The how-to card the assistant shows for "how do I …": the clip (muted, looped, loaded only once in
 * view, with its poster until then) and its steps; it plays while in view and pauses when it scrolls
 * away; a viewer's pause sticks; with reduced motion it stays on the poster behind a play button; a card
 * still being written draws a placeholder.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCardProps, type HowToCard } from '@collab/shared';
import type { CardEnv } from '../../src/assistant/cards';
import { HowToCardView, clipUrls } from '../../src/assistant/how-to-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CARD: HowToCard = {
  clip_id: 'link-tasks',
  title: 'Link two tasks',
  steps: ['Point at the first task’s bar: a small dot appears at each end.', 'Drag from the dot at its end to the start of the task that has to wait.', 'Let go: the arrow is drawn.'],
};
const ENV: CardEnv = { currency: 'USD', canViewCosts: true, active: true, partial: false };

/** IntersectionObserver stand-in: `show(ratio)` reports the card's visibility to every observer. */
const observers: { callback: IntersectionObserverCallback; element: Element | null }[] = [];
class FakeObserver {
  private readonly entry: { callback: IntersectionObserverCallback; element: Element | null };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, element: null };
    observers.push(this.entry);
  }
  observe(element: Element) {
    this.entry.element = element;
  }
  disconnect() {
    observers.splice(observers.indexOf(this.entry), 1);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function show(ratio: number) {
  for (const { callback, element } of [...observers]) {
    callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio, target: element! } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
}

function reducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalMatchMedia = window.matchMedia;

async function render(card: Partial<HowToCard>, env: CardEnv = ENV) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<HowToCardView card={card} env={env} />));
  return host;
}

beforeEach(() => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  // jsdom has no media playback: play/pause just fire their events.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'));
  });
  reducedMotion(false);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  host?.remove();
  observers.length = 0;
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

describe('the how-to card', () => {
  it('shows the clip muted and looped, loaded only once in view, with its poster and steps', async () => {
    const view = await render(CARD);
    expect(view.querySelector('[data-testid="assistant-how-card"] .ac-kicker')?.textContent).toBe('How to');
    expect(view.querySelector('.ac-title')?.textContent).toBe('Link two tasks');
    const video = view.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/clips/link-tasks.webm');
    expect(video.getAttribute('poster')).toBe('/clips/link-tasks.png');
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('none');
    expect([...view.querySelectorAll('.ac-how-steps li')].map((item) => item.textContent)).toEqual(CARD.steps);
    expect(clipUrls('watch-recipe')).toEqual({ video: '/clips/watch-recipe.webm', poster: '/clips/watch-recipe.png' });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('plays while in view and pauses when it scrolls away', async () => {
    const view = await render(CARD);
    await act(async () => show(0.2));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    await act(async () => show(0.8));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(view.querySelector('.ac-how-clip')?.classList.contains('is-playing')).toBe(true);
    expect(view.querySelector('[data-testid="assistant-how-toggle"]')?.getAttribute('aria-label')).toBe('Pause the clip');
    await act(async () => show(0));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(view.querySelector('.ac-how-clip')?.classList.contains('is-playing')).toBe(false);
    await act(async () => show(1));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('stays paused once the viewer pauses it, until they press play', async () => {
    const view = await render(CARD);
    await act(async () => show(1));
    await act(async () => (view.querySelector('[data-testid="assistant-how-toggle"]') as HTMLButtonElement).click());
    expect(view.querySelector('.ac-how-clip')?.classList.contains('is-playing')).toBe(false);
    await act(async () => show(0));
    await act(async () => show(1));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    const play = view.querySelector('[data-testid="assistant-how-play"]') as HTMLButtonElement;
    expect(play.getAttribute('aria-label')).toBe('Play the clip: Link two tasks');
    await act(async () => play.click());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });

  it('with reduced motion, shows the poster and a play button instead of playing', async () => {
    reducedMotion(true);
    const view = await render(CARD);
    await act(async () => show(1));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    const play = view.querySelector('[data-testid="assistant-how-play"]') as HTMLButtonElement;
    expect(play).not.toBeNull();
    await act(async () => play.click());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(view.querySelector('[data-testid="assistant-how-play"]')).toBeNull();
    expect(view.querySelector('[data-testid="assistant-how-toggle"]')?.getAttribute('aria-label')).toBe('Pause the clip');
  });

  it('says so when the clip cannot load', async () => {
    const view = await render(CARD);
    await act(async () => view.querySelector('video')!.dispatchEvent(new Event('error')));
    expect(view.querySelector('.ac-how-failed')?.textContent).toBe('The clip could not be loaded.');
  });

  it('draws a placeholder while the card is being written, and no video for an id that is not a clip', async () => {
    const view = await render({}, { ...ENV, partial: true });
    expect(view.querySelector('.ac-skeleton')).not.toBeNull();
    expect(view.querySelector('video')).toBeNull();
    expect(view.querySelector('.ac-how-clip.is-waiting')).not.toBeNull();
    // The stored card is checked against the shared schema before it is drawn.
    expect(parseCardProps('show_how', { ...CARD, clip_id: '../../etc' })).toBeNull();
    expect(parseCardProps('show_how', CARD)).toEqual(CARD);
  });
});
