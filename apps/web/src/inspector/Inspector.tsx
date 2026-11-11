/**
 * The right-hand sidebar: a rail of icon tabs and the panel of the active tab. One place for
 * everything that is not the plan itself (the selected task, the fix and its payment, crews, the
 * task library, the changelog), instead of buttons and pop-ups spread over the header and toolbar.
 * Clicking the active tab collapses the panel; the rail stays.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useDismiss } from '../app/useDismiss';
import '../styles/inspector.css';

export type InspectorTabId = 'task' | 'assistant' | 'alerts' | 'rentals' | 'crews' | 'library' | 'documents' | 'history';

export type InspectorTab = {
  id: InspectorTabId;
  label: string;
  /** A small count or dot on the rail icon (e.g. something waiting for this viewer). */
  badge?: string | number | null;
  /** Shown beside the label in the rail tooltip. */
  hint?: string;
  /** Tucked under More on the rail until someone opens it. */
  more?: boolean;
  render(): ReactNode;
} & (
  | {
      /** FontAwesome icon name, e.g. `pen-to-square`. */
      icon: string;
      mark?: undefined;
    }
  | {
      icon?: undefined;
      /** Drawn instead of an icon, such as Remy's mark. */
      mark: ReactNode;
    }
);

export interface InspectorProps {
  tabs: InspectorTab[];
  active: InspectorTabId | null;
  onActive(tab: InspectorTabId | null): void;
}

function RailButton({ tab, active, onActive }: { tab: InspectorTab; active: InspectorTabId | null; onActive: InspectorProps['onActive'] }) {
  return (
    <button
      type="button"
      className={`inspector-tab${tab.id === active ? ' is-active' : ''}`}
      aria-pressed={tab.id === active}
      aria-label={tab.label}
      title={tab.hint ? `${tab.label}: ${tab.hint}` : tab.label}
      data-testid={`inspector-tab-${tab.id}`}
      onClick={() => onActive(tab.id === active ? null : tab.id)}
    >
      {tab.mark ? <span className="inspector-tab-mark">{tab.mark}</span> : <i className={`fa fa-${tab.icon}`} aria-hidden="true" />}
      <span className="inspector-tab-label">{tab.label}</span>
      {tab.badge != null && tab.badge !== '' && tab.badge !== 0 && <span className="inspector-tab-badge">{tab.badge}</span>}
    </button>
  );
}

export function Inspector({ tabs, active, onActive }: InspectorProps) {
  const current = tabs.find((tab) => tab.id === active) ?? null;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRoot = useRef<HTMLDivElement>(null);
  useDismiss(moreOpen, moreRoot, () => setMoreOpen(false));
  const onRail = tabs.filter((tab) => !tab.more || tab.id === active);
  const tucked = tabs.filter((tab) => tab.more && tab.id !== active);
  return (
    <div className={`inspector${current ? ' is-open' : ''}`} data-testid="inspector">
      {current && (
        <section className="inspector-panel" aria-label={current.label} data-tab={current.id}>
          {current.render()}
        </section>
      )}
      <nav className="inspector-rail" aria-label="Side panel">
        {onRail.map((tab) => (
          <RailButton key={tab.id} tab={tab} active={active} onActive={onActive} />
        ))}
        {tucked.length > 0 && (
          <div className="inspector-more" ref={moreRoot}>
            <button type="button" className={`inspector-tab${moreOpen ? ' is-active' : ''}`} aria-label="More" aria-expanded={moreOpen} data-testid="inspector-more" onClick={() => setMoreOpen((open) => !open)}>
              <i className="fa fa-ellipsis" aria-hidden="true" />
              <span className="inspector-tab-label">More</span>
            </button>
            {moreOpen && (
              <div className="popover inspector-more-menu" role="menu">
                {tucked.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    data-testid={`inspector-tab-${tab.id}`}
                    onClick={() => {
                      setMoreOpen(false);
                      onActive(tab.id);
                    }}
                  >
                    {tab.mark ? <span className="inspector-tab-mark is-inline">{tab.mark}</span> : <i className={`fa fa-${tab.icon}`} aria-hidden="true" />} {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

/**
 * The common head of an inspector panel: title, one line of context, optional actions. `mark` is drawn
 * in the icon's place, such as Remy's mark on her panel.
 */
export function InspectorHeader({ title, subtitle, icon, mark, actions }: { title: ReactNode; subtitle?: ReactNode; icon?: string; mark?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="panel-head inspector-head">
      {mark ? (
        <span className="inspector-head-icon inspector-head-mark" aria-hidden="true">
          {mark}
        </span>
      ) : (
        icon && <i className={`fa fa-${icon} inspector-head-icon`} aria-hidden="true" />
      )}
      <div className="panel-head-text">
        <h2 className="panel-head-title">{title}</h2>
        {subtitle && <p className="panel-head-sub">{subtitle}</p>}
      </div>
      {actions && <div className="panel-head-actions">{actions}</div>}
    </header>
  );
}
