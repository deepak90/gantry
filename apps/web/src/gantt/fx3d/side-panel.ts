/**
 * The app's side panel over the 3D scene. It lives in the page, which fades and scales with the scene, so to be used
 * over the scene its container comes out of the page; its place is held, so that the chart doesn't reflow behind. It
 * slides in from the right and back out, under a small bar that picks what it shows and closes it (the rail stays
 * behind: most of what is on it is about the chart).
 */
import { ASSISTANT_NAME } from '../../assistant/identity';
import { remyMarkElement } from '../../assistant/RemyMark';

export type PanelTab = 'task' | 'assistant' | 'alerts';

export interface SidePanelOptions {
  /** Brings a tab forward; says false when this person doesn't have it. */
  showTab: (tab: PanelTab) => boolean;
  hasAssistant: () => boolean;
  reducedMotion: boolean;
  /** It opened or closed, or what it shows changed. */
  onChange: (opening: boolean | null) => void;
}

export interface SidePanel {
  open(tab: PanelTab): boolean;
  /** Over the scene as it is in the page, whatever it shows; false when nothing is open there. */
  liftAsIs(): boolean;
  /** Back into the page: at once when the whole scene is leaving with it. */
  close(atOnce?: boolean): void;
  isOpen(): boolean;
  /** What it shows now, whichever way that came about. */
  tab(): string | null;
  width(): number;
  destroy(): void;
}

const SLIDE_MS = 260;
const TABS: readonly { id: PanelTab; label: string; icon: string }[] = [
  { id: 'task', label: 'Task', icon: 'pen-to-square' },
  { id: 'assistant', label: ASSISTANT_NAME, icon: 'remy' },
  { id: 'alerts', label: 'Watch list', icon: 'bell' },
];

export function createSidePanel({ showTab, hasAssistant, reducedMotion, onChange }: SidePanelOptions): SidePanel {
  let lifted = false;
  let leaving = 0;
  const host = (): HTMLElement | null => document.querySelector<HTMLElement>('.inspector-host');
  const shownTab = (): string | null => host()?.querySelector<HTMLElement>('.inspector-panel')?.dataset.tab ?? null;

  const bar = document.createElement('div');
  bar.className = 'fx3d-panelbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Side panel');
  const buttons = TABS.map(({ id, label, icon }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fx3d-panelbar-tab';
    button.dataset.testid = `fx3d-panel-${id}`;
    const glyph = icon === 'remy' ? remyMarkElement('still', 'fx3d-mark') : document.createElement('i');
    if (icon !== 'remy') glyph.setAttribute('class', `fa fa-${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph, ` ${label}`);
    button.addEventListener('click', () => {
      showTab(id);
      sync();
    });
    return { id, button };
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'button is-quiet is-icon is-sm fx3d-panelbar-close';
  closeButton.setAttribute('aria-label', 'Close the side panel');
  closeButton.title = 'Close';
  closeButton.dataset.testid = 'fx3d-panel-close';
  const closeGlyph = document.createElement('i');
  closeGlyph.className = 'fa fa-xmark';
  closeGlyph.setAttribute('aria-hidden', 'true');
  closeButton.append(closeGlyph);
  closeButton.addEventListener('click', () => {
    close();
    // Closed, not just put away: the page's own tab for it closes too (its rail button toggles it), so nothing
    // reopens it behind the scene.
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('.inspector-host .inspector-rail .inspector-tab.is-active')?.click(), reducedMotion ? 0 : SLIDE_MS + 20);
  });
  bar.append(...buttons.map(({ button }) => button), closeButton);

  function sync(): void {
    const shown = shownTab();
    for (const { id, button } of buttons) {
      button.setAttribute('aria-pressed', String(id === shown));
      if (id === 'assistant') button.hidden = !hasAssistant();
    }
  }

  // Whichever way the tab changes (a card opening the fix, say), the bar says so, and so does the scene's own button.
  const watcher = new MutationObserver(() => {
    sync();
    onChange(null);
  });

  function putBack(): void {
    window.clearTimeout(leaving);
    leaving = 0;
    const panel = host();
    const spot = document.querySelector<HTMLElement>('.inspector-spot');
    bar.remove();
    watcher.disconnect();
    if (!panel || !spot) return;
    spot.append(panel);
    panel.classList.remove('is-lifted', 'is-leaving');
    spot.classList.remove('is-holding');
    spot.style.removeProperty('width');
  }

  function open(tab: PanelTab): boolean {
    if (!showTab(tab)) return false;
    const panel = host();
    const spot = document.querySelector<HTMLElement>('.inspector-spot');
    if (!panel || !spot) return false;
    // Coming back while it is on its way out: it just turns around.
    if (leaving) {
      window.clearTimeout(leaving);
      leaving = 0;
      panel.classList.remove('is-leaving');
    }
    if (!lifted) {
      lifted = true;
      if (!panel.classList.contains('is-lifted')) {
        spot.style.width = `${panel.getBoundingClientRect().width || (panel.firstElementChild as HTMLElement | null)?.offsetWidth || 0}px`;
        spot.classList.add('is-holding');
        panel.classList.add('is-lifted');
        panel.append(bar);
        document.body.append(panel);
        watcher.observe(panel, { subtree: true, attributes: true, attributeFilter: ['data-tab'] });
      }
      onChange(true);
    }
    sync();
    return true;
  }

  function liftAsIs(): boolean {
    if (lifted) return true;
    const panel = host();
    const spot = document.querySelector<HTMLElement>('.inspector-spot');
    if (!panel || !spot || !panel.querySelector('.inspector-panel')) return false;
    if (leaving) {
      window.clearTimeout(leaving);
      leaving = 0;
      panel.classList.remove('is-leaving');
    }
    lifted = true;
    if (!panel.classList.contains('is-lifted')) {
      spot.style.width = `${panel.getBoundingClientRect().width || (panel.firstElementChild as HTMLElement | null)?.offsetWidth || 0}px`;
      spot.classList.add('is-holding');
      panel.classList.add('is-lifted');
      panel.append(bar);
      document.body.append(panel);
      watcher.observe(panel, { subtree: true, attributes: true, attributeFilter: ['data-tab'] });
    }
    onChange(true);
    sync();
    return true;
  }

  function close(atOnce = false): void {
    if (!lifted) {
      if (atOnce && leaving) putBack();
      return;
    }
    lifted = false;
    const panel = host();
    if (atOnce || reducedMotion || !panel) putBack();
    else {
      panel.classList.add('is-leaving');
      leaving = window.setTimeout(putBack, SLIDE_MS);
    }
    onChange(false);
  }

  return {
    open,
    liftAsIs,
    close,
    isOpen: () => lifted,
    tab: shownTab,
    width: () => document.querySelector('.inspector-host.is-lifted > .inspector')?.getBoundingClientRect().width ?? 0,
    destroy() {
      if (lifted || leaving) putBack();
      lifted = false;
      watcher.disconnect();
    },
  };
}
