/**
 * The column selector and the column editor: two small pop-overs that live with the grid (the "+"
 * at the right end of the header row opens the selector; a header's menu opens the editor). Both are
 * stateless over the viewer's column layout: every change is a pure layout function handed to
 * `onChange`, applied to the grid and stored by the workspace.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  COLUMN_GROUPS,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  TASK_COLUMN_ID,
  columnAlign,
  columnDefinition,
  columnTitle,
  columnWidth,
  defaultColumnTitle,
  hiddenColumns,
  hideColumn,
  isDefaultColumnLayout,
  matchesColumnSearch,
  moveColumn,
  moveColumnBy,
  resetColumnLayout,
  setColumnAlign,
  setColumnTitle,
  setColumnWidth,
  showColumn,
  type ColumnAccess,
  type ColumnAlign,
  type ColumnDefinition,
  type ColumnLayout,
} from './column-layout';
import '../styles/columns.css';

export type LayoutChange = (layout: ColumnLayout) => ColumnLayout;

// -----------------------------------------------------------------------------------------
// A pop-over anchored under an element of the grid
// -----------------------------------------------------------------------------------------

interface AnchoredPopoverProps {
  /** The element to sit under (looked up again whenever the grid may have moved it). */
  anchor(): HTMLElement | null;
  onClose(): void;
  /** Pointer-downs on these elements do not close the pop-over (e.g. the button that toggles it). */
  keepOpenOn?: (target: Element) => boolean;
  /** Changes whenever the anchor may have moved (the layout). */
  measureKey: string;
  /** Selector of the element focused on open. */
  initialFocus?: string;
  label: string;
  testId: string;
  className: string;
  width: number;
  children: ReactNode;
}

const GAP = 6;
const MARGIN = 8;

function AnchoredPopover({ anchor, onClose, keepOpenOn, measureKey, initialFocus, label, testId, className, width, children }: AnchoredPopoverProps) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const close = useRef(onClose);
  close.current = onClose;

  const measure = () => {
    const element = anchor();
    if (!element || !element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
    const top = rect.bottom + GAP;
    setPosition({ left, top, width, maxHeight: Math.max(220, window.innerHeight - top - MARGIN) });
  };

  useLayoutEffect(measure, []);
  // The grid redraws its headers after the layout is applied: measure once it has.
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measureKey]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || root.current?.contains(target) || keepOpenOn?.(target)) return;
      close.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
    };
    const onResize = () => close.current();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    // A Bryntum menu that just closed hands focus back to the grid; take it after that.
    const focusTimer = window.setTimeout(() => {
      const target = initialFocus ? root.current?.querySelector<HTMLElement>(initialFocus) : null;
      (target ?? root.current)?.focus();
      if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    }, 40);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(focusTimer);
    };
  }, []);

  return createPortal(
    <div ref={root} className={`popover gcol-popover ${className}`} role="dialog" aria-label={label} data-testid={testId} tabIndex={-1} style={{ position: 'fixed', ...position }}>
      {children}
    </div>,
    document.body,
  );
}

function headerOf(grid: HTMLElement | null | undefined, columnId: string): HTMLElement | null {
  return grid?.querySelector<HTMLElement>(`.b-grid-header[data-column-id="${columnId}"]`) ?? null;
}

const measureKeyOf = (layout: ColumnLayout) => `${layout.visible.join(',')}|${JSON.stringify(layout.widths)}`;

// -----------------------------------------------------------------------------------------
// Column selector
// -----------------------------------------------------------------------------------------

export interface ColumnPickerProps {
  layout: ColumnLayout;
  access: ColumnAccess;
  onChange(change: LayoutChange): void;
  /** Opens the column editor for a shown column. */
  onEdit(columnId: string): void;
  onClose(): void;
  /** The Gantt's element: the selector sits under its "+" header. */
  grid: HTMLElement | null | undefined;
  /** Id of the "+" column. */
  anchorColumnId: string;
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span className={`gcol-check${checked ? ' is-checked' : ''}`} aria-hidden="true">
      {checked && <i className="fa fa-check" />}
    </span>
  );
}

function OptionText({ definition, title }: { definition: ColumnDefinition; title: string }) {
  const renamed = title !== defaultColumnTitle(definition.id);
  return (
    <span className="gcol-option-text">
      <span className="gcol-option-label">{renamed ? title : definition.label}</span>
      {(renamed || definition.hint) && <small>{renamed ? definition.label : definition.hint}</small>}
    </span>
  );
}

export function ColumnPicker({ layout, access, onChange, onEdit, onClose, grid, anchorColumnId }: ColumnPickerProps) {
  const [query, setQuery] = useState('');
  // A row is dragged by its grip. Pointer events arrive faster than React renders: the handlers keep
  // the drag in a ref, the rows draw it from state.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const drag = useRef<{ id: string | null; at: number | null }>({ id: null, at: null });
  const shownList = useRef<HTMLUListElement>(null);
  const searching = query.trim() !== '';

  const shown = layout.visible
    .map((id) => columnDefinition(id))
    .filter((definition): definition is ColumnDefinition => definition !== undefined)
    .filter((definition) => matchesColumnSearch(layout, definition, query));
  const hidden = hiddenColumns(layout, access).filter((definition) => matchesColumnSearch(layout, definition, query));
  const groups = COLUMN_GROUPS.map((group) => ({ ...group, columns: hidden.filter((definition) => definition.group === group.id) })).filter((group) => group.columns.length > 0);

  const endDrag = () => {
    drag.current = { id: null, at: null };
    setDragging(null);
    setDropAt(null);
  };

  /** Where a drop at `clientY` goes: before the row whose middle is below it (never before the task column). */
  const dropIndexAt = (clientY: number) => {
    const rows = Array.from(shownList.current?.children ?? []);
    const below = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return Math.max(1, below === -1 ? rows.length : below);
  };

  const onGripPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.focus();
    grip.setPointerCapture(event.pointerId);
    drag.current = { id, at: null };
    setDragging(id);
    const move = (moved: PointerEvent) => {
      const at = dropIndexAt(moved.clientY);
      if (at === drag.current.at) return;
      drag.current.at = at;
      setDropAt(at);
    };
    const finish = (commit: boolean) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
      const { at } = drag.current;
      endDrag();
      if (!commit || at === null) return;
      onChange((current) => {
        const from = current.visible.indexOf(id);
        return moveColumn(current, id, at > from ? at - 1 : at);
      });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
  };

  const onGripKey = (event: KeyboardEvent<HTMLElement>, id: string) => {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    onChange((current) => moveColumnBy(current, id, delta));
  };

  return (
    <AnchoredPopover
      anchor={() => headerOf(grid, anchorColumnId)}
      onClose={onClose}
      keepOpenOn={(target) => Boolean(target.closest(`.b-grid-header[data-column-id="${anchorColumnId}"]`))}
      measureKey={measureKeyOf(layout)}
      initialFocus=".gcol-search input"
      label="Columns"
      testId="column-picker"
      className="gcol-picker"
      width={340}
    >
      <header className="gcol-head">
        <p className="gcol-title">Columns</p>
        <label className="gcol-search">
          <i className="fa fa-magnifying-glass" aria-hidden="true" />
          <input type="text" className="input" placeholder="Find a column" aria-label="Find a column" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="column-picker-search" />
        </label>
      </header>

      <div className="gcol-scroll">
        {shown.length > 0 && (
          <section className="gcol-section" aria-label="Shown">
            <p className="section-label gcol-section-title">
              Shown{!searching && <span> · drag to reorder</span>}
            </p>
            <ul className={`gcol-list${dragging ? ' is-sorting' : ''}`} ref={shownList}>
              {shown.map((definition, index) => {
                const fixed = definition.id === TASK_COLUMN_ID;
                const canDrag = !fixed && !searching;
                const drop = dropAt === index ? ' is-drop-before' : dropAt === index + 1 && index === shown.length - 1 ? ' is-drop-after' : '';
                return (
                  <li key={definition.id} className={`gcol-row${dragging === definition.id ? ' is-dragging' : ''}${drop}`}>
                    {canDrag ? (
                      <button
                        type="button"
                        className="gcol-grip"
                        aria-label={`Move ${columnTitle(layout, definition.id)}: arrow up or down`}
                        title="Drag to reorder"
                        data-testid={`column-grip-${definition.id}`}
                        onPointerDown={(event) => onGripPointerDown(event, definition.id)}
                        onKeyDown={(event) => onGripKey(event, definition.id)}
                      >
                        <i className="fa fa-grip-vertical" aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="gcol-grip is-locked" title={fixed ? 'The task column always comes first' : undefined}>
                        <i className={`fa fa-${fixed ? 'lock' : 'grip-vertical'}`} aria-hidden="true" />
                      </span>
                    )}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked="true"
                      aria-disabled={fixed || undefined}
                      className="gcol-option"
                      data-testid={`column-option-${definition.id}`}
                      title={fixed ? 'The task column is always shown' : `Hide ${columnTitle(layout, definition.id)}`}
                      onClick={() => {
                        if (!fixed) onChange((current) => hideColumn(current, definition.id));
                      }}
                    >
                      <Checkbox checked />
                      <OptionText definition={definition} title={columnTitle(layout, definition.id)} />
                    </button>
                    <button type="button" className="button is-quiet is-sm is-icon gcol-edit" aria-label={`Edit ${columnTitle(layout, definition.id)}`} title="Rename, resize, align" data-testid={`column-edit-${definition.id}`} onClick={() => onEdit(definition.id)}>
                      <i className="fa fa-pen" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {groups.map((group) => (
          <section key={group.id} className="gcol-section" aria-label={group.label}>
            <p className="section-label gcol-section-title">{group.label}</p>
            <ul className="gcol-list">
              {group.columns.map((definition) => (
                <li key={definition.id} className="gcol-row">
                  <span className="gcol-grip is-blank" aria-hidden="true" />
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked="false"
                    className="gcol-option"
                    data-testid={`column-option-${definition.id}`}
                    title={`Show ${columnTitle(layout, definition.id)}`}
                    onClick={() => onChange((current) => showColumn(current, definition.id, access))}
                  >
                    <Checkbox checked={false} />
                    <OptionText definition={definition} title={columnTitle(layout, definition.id)} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {shown.length === 0 && groups.length === 0 && <p className="gcol-empty">No column matches “{query.trim()}”.</p>}
      </div>

      <footer className="gcol-foot">
        <span className="gcol-foot-hint">Right-click a header for more</span>
        <button type="button" className="button is-sm" data-testid="column-picker-reset" disabled={isDefaultColumnLayout(layout)} onClick={() => onChange(() => resetColumnLayout())}>
          <i className="fa fa-rotate-left" aria-hidden="true" /> Reset to default
        </button>
      </footer>
    </AnchoredPopover>
  );
}

// -----------------------------------------------------------------------------------------
// Column editor
// -----------------------------------------------------------------------------------------

export interface ColumnEditorProps {
  columnId: string;
  layout: ColumnLayout;
  onChange(change: LayoutChange): void;
  onClose(): void;
  /** Back to the column selector. */
  onShowAll(): void;
  grid: HTMLElement | null | undefined;
}

const ALIGN_CHOICES: { value: ColumnAlign; label: string; icon: string }[] = [
  { value: 'start', label: 'Left', icon: 'align-left' },
  { value: 'center', label: 'Center', icon: 'align-center' },
  { value: 'end', label: 'Right', icon: 'align-right' },
];

const WIDTH_STEP = 10;

export function ColumnEditor({ columnId, layout, onChange, onClose, onShowAll, grid }: ColumnEditorProps) {
  const definition = columnDefinition(columnId);
  const minWidth = definition?.minWidth ?? MIN_COLUMN_WIDTH;
  const title = columnTitle(layout, columnId);
  const width = Math.max(minWidth, columnWidth(layout, columnId));
  const [titleText, setTitleText] = useState(title);
  const [widthText, setWidthText] = useState(String(width));
  const editingWidth = useRef(false);

  // The width also changes from the grid (dragging the header edge) while the editor is open.
  useEffect(() => {
    if (!editingWidth.current) setWidthText(String(width));
  }, [width]);

  if (!definition) return null;
  const fixed = definition.id === TASK_COLUMN_ID;
  const index = layout.visible.indexOf(columnId);
  const defaultTitle = defaultColumnTitle(columnId);
  const align = columnAlign(layout, columnId);

  const commitWidth = (text: string) => {
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) onChange((current) => setColumnWidth(current, columnId, value));
  };
  const stepWidth = (delta: number) => {
    editingWidth.current = false;
    onChange((current) => setColumnWidth(current, columnId, Math.max(minWidth, columnWidth(current, columnId)) + delta));
  };

  return (
    <AnchoredPopover
      anchor={() => headerOf(grid, columnId)}
      onClose={onClose}
      measureKey={measureKeyOf(layout)}
      initialFocus="[data-testid=column-editor-title]"
      label={`Edit column ${title}`}
      testId="column-editor"
      className="gcol-editor"
      width={288}
    >
      <header className="gcol-head gcol-editor-head">
        <p className="gcol-title">Edit column</p>
        <button type="button" className="button is-link" onClick={onShowAll}>
          All columns
        </button>
      </header>

      <div className="gcol-fields">
        <label className="field">
          <span className="field-label">Name</span>
          <span className="gcol-input-row">
            <input
              type="text"
              className="input"
              data-testid="column-editor-title"
              value={titleText}
              placeholder={defaultTitle}
              maxLength={60}
              onChange={(event) => {
                setTitleText(event.target.value);
                onChange((current) => setColumnTitle(current, columnId, event.target.value));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onClose();
              }}
            />
            {title !== defaultTitle && (
              <button
                type="button"
                className="button is-icon"
                aria-label={`Back to “${defaultTitle}”`}
                title={`Back to “${defaultTitle}”`}
                onClick={() => {
                  setTitleText(defaultTitle);
                  onChange((current) => setColumnTitle(current, columnId, ''));
                }}
              >
                <i className="fa fa-rotate-left" aria-hidden="true" />
              </button>
            )}
          </span>
        </label>

        <div className="gcol-field-row">
          <label className="field">
            <span className="field-label">Width</span>
            <span className="gcol-stepper">
              <button type="button" className="button is-sm is-icon" aria-label="Narrower" disabled={width <= minWidth} onClick={() => stepWidth(-WIDTH_STEP)}>
                <i className="fa fa-minus" aria-hidden="true" />
              </button>
              <input
                type="number"
                className="input"
                inputMode="numeric"
                data-testid="column-editor-width"
                min={minWidth}
                max={MAX_COLUMN_WIDTH}
                step={WIDTH_STEP}
                value={widthText}
                onFocus={() => {
                  editingWidth.current = true;
                }}
                onChange={(event) => {
                  setWidthText(event.target.value);
                  const value = Number(event.target.value);
                  if (value >= minWidth && value <= MAX_COLUMN_WIDTH) commitWidth(event.target.value);
                }}
                onBlur={(event) => {
                  editingWidth.current = false;
                  commitWidth(event.target.value);
                  setWidthText(String(Math.max(minWidth, columnWidth(layout, columnId))));
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                }}
              />
              <span className="gcol-unit">px</span>
              <button type="button" className="button is-sm is-icon" aria-label="Wider" disabled={width >= MAX_COLUMN_WIDTH} onClick={() => stepWidth(WIDTH_STEP)}>
                <i className="fa fa-plus" aria-hidden="true" />
              </button>
            </span>
          </label>

          <div className="field">
            <span className="field-label" id="gcol-align-label">
              Align
            </span>
            <span className="segmented gcol-segmented" role="radiogroup" aria-labelledby="gcol-align-label" data-testid="column-editor-align">
              {ALIGN_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={align === choice.value}
                  aria-label={choice.label}
                  title={choice.label}
                  onClick={() => onChange((current) => setColumnAlign(current, columnId, choice.value))}
                >
                  <i className={`fa fa-${choice.icon}`} aria-hidden="true" />
                </button>
              ))}
            </span>
          </div>
        </div>

        {!fixed && (
          <div className="field">
            <span className="field-label">Position</span>
            <span className="gcol-move">
              <button type="button" className="button is-sm" data-testid="column-editor-left" disabled={index <= 1} onClick={() => onChange((current) => moveColumnBy(current, columnId, -1))}>
                <i className="fa fa-arrow-left" aria-hidden="true" /> Move left
              </button>
              <button type="button" className="button is-sm" data-testid="column-editor-right" disabled={index < 0 || index >= layout.visible.length - 1} onClick={() => onChange((current) => moveColumnBy(current, columnId, 1))}>
                Move right <i className="fa fa-arrow-right" aria-hidden="true" />
              </button>
            </span>
          </div>
        )}
      </div>

      <footer className="gcol-foot">
        <button
          type="button"
          className="button is-sm is-quiet"
          data-testid="column-editor-hide"
          disabled={fixed}
          title={fixed ? 'The task column is always shown' : undefined}
          onClick={() => {
            onChange((current) => hideColumn(current, columnId));
            onClose();
          }}
        >
          <i className="fa fa-eye-slash" aria-hidden="true" /> Hide column
        </button>
        <button type="button" className="button is-sm is-primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </AnchoredPopover>
  );
}
