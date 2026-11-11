// @vitest-environment node
/**
 * The landing page's sheets: the claim and the way in over the model of the building, the film with its chapters, the
 * call drawn in code, the odds, the money, and the way in once more. What the 3D parts draw is checked where they are
 * built (landing/model.ts, landing/odds.ts); this holds the page to its shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPage, SITE_PAGES } from '../../site-pages';
import { markDrawing } from '../../src/assistant/RemyMark';
import { START_SESSION_LABEL } from '../../src/site/site-config';

const web = fileURLToPath(new URL('../..', import.meta.url));
const landing = renderPage(readFileSync(join(web, SITE_PAGES.landing.file), 'utf8'), SITE_PAGES.landing);
const section = (id: string) => new RegExp(`<section [^>]*id="${id}"[\\s\\S]*?</section>`).exec(landing)?.[0] ?? '';

describe('the landing page', () => {
  it('opens on the claim, one way in, and the model of the building', () => {
    const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(landing)?.[0] ?? '';
    expect(hero).toMatch(/<h1 id="hero-title"><span>Pay the crew\.<\/span> <span>Pour the slab\.<\/span><\/h1>/);
    expect(hero).toMatch(/where plans become <span class="hero-concrete">concrete<\/span>\./);
    // Remy's mark beside her name is the one the app draws (assistant/RemyMark.tsx).
    expect(hero).toContain(
      `<span class="hero-remy"><svg class="hero-remy-mark" viewBox="0 0 120 120" aria-hidden="true" focusable="false">${markDrawing('hero-remy')}</svg>Remy</span>, your AI&nbsp;coordinator,`,
    );
    expect(hero).toMatch(/pay the crews with PayPal\./);
    expect(hero.match(/class="button is-primary is-xl"/g)).toHaveLength(1);
    expect(hero).toContain(`>${START_SESSION_LABEL}</a>`);
    expect(hero).toMatch(/<div class="model" data-model><\/div>/);
    // The model says what it shows to screen readers.
    expect(hero).toMatch(/<span class="visually-hidden">The app’s own 3D model of Harbor Street Offices\./);
  });

  it('puts the film second, with its chapters linked to their moments', () => {
    const order = [...landing.matchAll(/<section class="([a-z-]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['hero', 'film-band', 'call-sheet', 'odds-sheet', 'pay-sheet', 'closing']);
    const chapters = /<ol class="chapters"[\s\S]*?<\/ol>/.exec(section('film'))?.[0] ?? '';
    expect(chapters.match(/href="https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}&amp;t=\d+s"/g)).toHaveLength(7);
  });

  it('shows Remy on the call and says plainly that people approve and pay', () => {
    const call = section('call');
    expect(call).toContain('data-scene');
    expect(call).toMatch(/She can’t approve or pay; people do\./);
  });

  it('leaves room for the odds and the money, with nothing invented on the page', () => {
    expect(section('odds')).toMatch(/<div class="odds-frame" data-odds><\/div>/);
    expect(section('paypal')).toContain('data-ledger');
  });

  it('keeps the old hero out: no ring of cards, no word drum, no film inside the name', () => {
    expect(landing).not.toMatch(/data-ring|data-drum|data-word|hero-word|ring-card/);
  });
});
