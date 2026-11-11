/**
 * What is on this tab's screen, read as the person sends Remy a message (ScreenContext in packages/shared/src/agent.ts):
 * the chart or the 3D site view with its day, whether its days are playing, the crane ride and the level looked at; the
 * side panel; a window over the page (the payment review, an invoice, the card that asks how to tie a library piece
 * in, the package editor); the open library card; the search and filter; the dates in view and the zoom. Short and
 * flat, so Remy knows what "close that", "go back" and "play this out" mean. Checked against the shared schema before
 * it goes; nothing here changes the page.
 */
import { ScreenContext, type ScreenContext as Screen } from '@collab/shared';
import type { GanttScreen } from '../gantt/GanttWorkspace';
import { libraryHands } from '../inspector/LibraryPanel';

export interface ScreenSources {
  chart(): GanttScreen | null;
  /** The side panel's tab, when one is open. */
  panel(): string | null;
  /** On a call: whether this tab hosts it. */
  call(): 'host' | 'guest' | null;
}

const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const clip = (text: string | null | undefined, max = 120) => {
  const words = text?.replace(/\s+/g, ' ').trim();
  return words ? words.slice(0, max) : null;
};
const QUICK_WORDS: Record<string, string> = { active: 'In progress', attention: 'Needs attention' };

/** The window or sheet over the page, if one is open, and what it is about. */
function openModal(doc: Document): Pick<Screen, 'modal' | 'modal_about'> {
  const pay = doc.querySelector('[data-testid="pay-modal"]');
  if (pay) return { modal: 'payment_review', modal_about: clip(pay.querySelector('.pay-modal-sub')?.textContent) };
  const invoice = doc.querySelector('[data-testid="invoice-modal"]');
  if (invoice) return { modal: 'invoice', modal_about: clip(invoice.querySelector('.pay-modal-sub')?.textContent) };
  const drop = libraryHands.current?.dropCard() ?? null;
  if (drop || doc.querySelector('[data-testid="library-choice"]')) return { modal: 'drop_card', modal_about: clip(drop) };
  const builder = doc.querySelector<HTMLElement>('[data-testid="snippet-builder"]');
  if (builder) return { modal: 'snippet_editor', modal_about: clip(builder.querySelector<HTMLInputElement>('[data-testid="builder-name"]')?.value) };
  return {};
}

/** This tab's screen now, or null when there is no plan on it. */
export function readScreen(sources: ScreenSources, doc: Document = document): Screen | null {
  const chart = sources.chart();
  if (!chart) return null;
  const site = chart.site();
  const onSite = Boolean(site?.siteOpen?.());
  const control = onSite ? (site?.siteControl?.() ?? null) : null;
  const state = control?.state() ?? null;
  const view = chart.view();
  const filters = [view.filter, view.quickFilter !== 'all' ? (QUICK_WORDS[view.quickFilter] ?? view.quickFilter) : null].filter(Boolean).join(' · ');
  const screen: Screen = {
    view: onSite ? 'site' : 'chart',
    ...(state?.day ? { site_day: state.day } : {}),
    ...(state ? { playing: state.playing, crane_ride: state.riding } : {}),
    ...(state?.level ? { level: clip(state.level, 60) } : {}),
    ...(sources.panel() ? { panel: sources.panel()!.slice(0, 30) } : {}),
    ...openModal(doc),
    ...(view.odds ? { odds: true } : {}),
    ...(libraryHands.current?.openName() ? { snippet: clip(libraryHands.current.openName()) } : {}),
    ...(view.search ? { search: view.search.slice(0, 80) } : {}),
    ...(filters ? { filter: clip(filters) } : {}),
    ...(!onSite && view.from && view.to ? { from: isoDay(view.from), to: isoDay(view.to) } : {}),
    ...(!onSite && view.zoom ? { zoom: view.zoom.slice(0, 30) } : {}),
    ...(sources.call() ? { call: sources.call()! } : {}),
  };
  // Nulls are left out: the line Remy reads stays short.
  for (const key of Object.keys(screen) as (keyof Screen)[]) if (screen[key] === null || screen[key] === undefined) delete screen[key];
  const checked = ScreenContext.safeParse(screen);
  return checked.success ? checked.data : null;
}
