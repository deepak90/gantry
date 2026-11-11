/**
 * Small pieces shared by the task panel's tabs: the edit runner (saving / saved / could-not-save),
 * labeled field rows, switches and selects, pills, crew badges and text that is saved when the
 * box is left.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BryntumDurationField, BryntumSlideToggle } from '@bryntum/gantt-react';
import type { ProjectModel } from '@bryntum/gantt';
import type { CurrencyCode } from '@collab/shared';

// -----------------------------------------------------------------------------------------
// Edits
// -----------------------------------------------------------------------------------------

export type EditState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

/**
 * Runs one edit at a time through the panel's status line; every edit is already its own
 * transaction. `failures` counts refused edits: the panel remounts its fields on each, so a field
 * that still shows what was typed (a refused date, say) shows the stored value again.
 */
export function useEditRunner(): { state: EditState; failures: number; run(edit: () => Promise<void>): Promise<boolean>; dismiss(): void } {
  const [state, setState] = useState<EditState>({ kind: 'idle' });
  const [failures, setFailures] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const run = useCallback(async (edit: () => Promise<void>) => {
    if (timer.current) clearTimeout(timer.current);
    setState({ kind: 'saving' });
    try {
      await edit();
      setState({ kind: 'saved' });
      timer.current = setTimeout(() => setState({ kind: 'idle' }), 1800);
      return true;
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      setFailures((count) => count + 1);
      return false;
    }
  }, []);
  const dismiss = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, failures, run, dismiss };
}

export interface TaskPanelContext {
  project: ProjectModel;
  currency: CurrencyCode;
  canViewCosts: boolean;
  /** Runs an edit and reports it in the status line; resolves false when it failed. */
  run(edit: () => Promise<void>): Promise<boolean>;
  /** Shows another task in the panel (and selects it in the plan). */
  openTask?(taskId: number): void;
}

const Context = createContext<TaskPanelContext | null>(null);

export const TaskPanelProvider = Context.Provider;

export function usePanel(): TaskPanelContext {
  const value = useContext(Context);
  if (!value) throw new Error('usePanel() outside the task panel');
  return value;
}

/** The latest value of a callback, for Bryntum widgets that keep the function they were given. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** The same Date object while the time stays the same, so a Bryntum field is not re-set on every render. */
export function useStableDate(value: Date | null): Date | null {
  const ref = useRef<Date | null>(value);
  const time = value ? value.getTime() : null;
  const current = ref.current ? ref.current.getTime() : null;
  if (time !== current) ref.current = value;
  return ref.current;
}

/** What a Bryntum field reports on change; only `userAction` changes are the person's. */
export interface FieldEvent<T = unknown> {
  value: T;
  checked?: boolean;
  userAction?: boolean;
}

export const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

// -----------------------------------------------------------------------------------------
// Layout
// -----------------------------------------------------------------------------------------

export function Row({
  label,
  hint,
  children,
  wide,
  htmlFor,
  testId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  htmlFor?: string;
  testId?: string;
}) {
  return (
    <div className={`field ti-row${wide ? ' is-wide' : ''}`} data-testid={testId}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ti-control">{children}</div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Section({ title, aside, children, testId }: { title: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="card ti-section" data-testid={testId}>
      <header className="ti-section-head">
        <h3 className="section-label">{title}</h3>
        {aside && <span className="ti-section-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * A Bryntum slide toggle with its label and a one-line hint under it. Only the person's own
 * changes (`userAction`) call `onChange`; the latest handler is used (Bryntum keeps the first).
 */
export function Switch({
  label,
  hint,
  checked,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange(checked: boolean): void;
}) {
  const handler = useLatest(onChange);
  return (
    <div className={`ti-switch${disabled ? ' is-disabled' : ''}`}>
      <BryntumSlideToggle
        cls="ti-toggle"
        text={label}
        checked={checked}
        disabled={disabled}
        dataset={testId ? { testid: testId } : undefined}
        onChange={({ value, checked: on, userAction }: FieldEvent) => {
          if (userAction) handler.current(Boolean(on ?? value));
        }}
      />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/**
 * A duration with its unit (Bryntum's DurationField, as its task editor uses for lag and effort):
 * type `2d`, `1w`, `4h` or use the spinner. Commits the person's changes only.
 */
export function DurationInput({
  magnitude,
  unit,
  units,
  allowNegative,
  ariaLabel,
  testId,
  disabled,
  onCommit,
}: {
  magnitude: number;
  unit: string;
  units: readonly string[];
  allowNegative?: boolean;
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
  onCommit(magnitude: number, unit: string): void;
}) {
  const handler = useLatest(onCommit);
  return (
    <BryntumDurationField
      cls="ti-field ti-duration"
      ariaLabel={ariaLabel}
      dataset={testId ? { testid: testId } : undefined}
      value={`${magnitude} ${unit}`}
      allowedUnits={units.join(',')}
      allowNegative={allowNegative}
      decimalPrecision={2}
      disabled={disabled}
      onChange={({ value, userAction }: FieldEvent<{ magnitude?: number | null; unit?: string } | null>) => {
        if (!userAction || !value || typeof value.magnitude !== 'number' || !Number.isFinite(value.magnitude) || !value.unit) return;
        handler.current(value.magnitude, value.unit);
      }}
    />
  );
}

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
}

/** A plain select over typed values (the DOM only knows strings). */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  disabled,
  className,
  id,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <select
      id={id}
      className={`input ti-select${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      value={String(value)}
      onChange={(event) => {
        const picked = options.find((option) => String(option.value) === event.target.value);
        if (picked && picked.value !== value) onChange(picked.value);
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)} title={option.title}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export type Tone = 'ok' | 'busy' | 'warn' | 'alert' | 'neutral';

/** The ui.css tone modifier of each tone, for pills and notes. */
export const TONE_CLASS: Readonly<Record<Tone, string>> = { ok: ' is-success', busy: ' is-info', warn: ' is-warning', alert: ' is-danger', neutral: '' };

/** PayPal's "P" monogram (public/paypal), for pills and lines about a PayPal payment. */
export const PAYPAL_MARK = '/paypal/paypal-mark.svg';

/** A state in a pill. A pill about a PayPal payment carries PayPal's mark, and once paid, PayPal's colors. */
export function Pill({ tone = 'neutral', icon, children, title }: { tone?: Tone; icon?: string; children: ReactNode; title?: string }) {
  const paypal = Boolean(icon?.includes('fa-paypal'));
  return (
    <span className={`pill${paypal && tone === 'ok' ? ' is-paypal' : TONE_CLASS[tone]}`} title={title}>
      {paypal ? (
        <img className="paypal-mark" src={PAYPAL_MARK} alt="" aria-hidden="true" />
      ) : (
        icon && <i className={icon.includes(' ') ? icon : `fa fa-${icon}`} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

export function Notice({ icon = 'circle-info', children, tone = 'neutral', testId }: { icon?: string; children: ReactNode; tone?: Tone; testId?: string }) {
  return (
    <p className={`note${TONE_CLASS[tone]}`} data-testid={testId}>
      <i className={`fa fa-${icon}`} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function CrewBadge({ color, icon, title, size = 'md' }: { color: string; icon: string; title?: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`ti-crew-badge is-${size}`} style={{ '--crew': color } as CSSProperties} title={title} aria-hidden={title ? undefined : true}>
      <i className={`fa fa-${icon}`} aria-hidden="true" />
    </span>
  );
}

// -----------------------------------------------------------------------------------------
// Text saved when the box is left
// -----------------------------------------------------------------------------------------

/**
 * A text box over a record value: typing never writes; leaving the box (or Enter in a one-line
 * box) saves once. While the box has focus a change from the other person does not overwrite what
 * is being typed; it shows once the box is left without changes.
 */
export function useCommittedText(value: string, commit: (next: string) => Promise<boolean>) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const reverted = useRef(false);
  const base = useRef(value);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
      base.current = value;
    }
  }, [value]);
  const onFocus = () => {
    focused.current = true;
    reverted.current = false;
    base.current = value;
  };
  /** Call on blur with the box's text. */
  const save = async (next: string) => {
    focused.current = false;
    if (reverted.current || next === base.current) {
      reverted.current = false;
      setDraft(value);
      base.current = value;
      return;
    }
    const ok = await commit(next);
    if (!ok) setDraft(value);
  };
  /** Esc: drop what was typed; the blur that follows saves nothing. */
  const revert = () => {
    reverted.current = true;
    setDraft(value);
  };
  return { draft, setDraft, onFocus, save, revert, changedElsewhere: focused.current && value !== base.current };
}

// -----------------------------------------------------------------------------------------
// Dates in words
// -----------------------------------------------------------------------------------------

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** `Mon, Dec 14`. */
export const shortDay = (date: Date | null | undefined): string => (date ? DAY.format(date) : '—');
/** `Mon, Dec 14, 2026`. */
export const longDay = (date: Date | null | undefined): string => (date ? DAY_YEAR.format(date) : '—');

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
