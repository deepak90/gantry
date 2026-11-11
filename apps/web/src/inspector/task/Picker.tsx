/**
 * A searchable list (Bryntum combo: typing filters by any part of the name). Picking an entry runs
 * `onPick` once, as one edit, and empties the box for the next pick.
 */
import { useMemo, useRef } from 'react';
import { BryntumCombo } from '@bryntum/gantt-react';
import { useLatest, usePanel } from './ui';

export interface PickerOption {
  id: number | string;
  text: string;
  /** A second line: where a task sits, or a crew's company. */
  sub?: string;
  /** FontAwesome icon name. */
  icon: string;
  /** Icon color (a crew's color). */
  color?: string;
  /** Shown quieter (phases among tasks). */
  muted?: boolean;
}

interface OptionRecord {
  data: { text: string; sub: string; icon: string; color: string; muted: boolean };
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function renderOption({ data }: OptionRecord): string {
  const style = data.color ? ` style="--crew:${escapeHtml(data.color)}"` : '';
  return `<div class="ti-option${data.muted ? ' is-muted' : ''}${data.color ? ' has-color' : ''}"${style}><span class="ti-option-icon"><i class="fa fa-${escapeHtml(data.icon)}"></i></span><span class="ti-option-text"><strong>${escapeHtml(data.text)}</strong>${
    data.sub ? `<em>${escapeHtml(data.sub)}</em>` : ''
  }</span></div>`;
}

export function Picker({ placeholder, options, onPick, testId }: { placeholder: string; options: PickerOption[]; onPick(id: number | string): Promise<void>; testId?: string }) {
  const { run } = usePanel();
  const combo = useRef<BryntumCombo>(null);
  const key = options.map((option) => `${option.id}:${option.text}:${option.sub ?? ''}`).join('|');
  const items = useMemo(
    () => options.map((option) => ({ value: option.id, text: option.text, sub: option.sub ?? '', icon: option.icon, color: option.color ?? '', muted: Boolean(option.muted) })),
    // The list is rebuilt only when what is on offer changes, not on every render.
    [key],
  );
  const handlers = useLatest({
    change: ({ value, userAction }: { value: unknown; userAction?: boolean }) => {
      if (!userAction || value === null || value === undefined || value === '') return;
      void run(() => onPick(value as number | string)).then(() => {
        const instance = combo.current?.instance as { value: unknown; isDestroyed?: boolean } | undefined;
        if (instance && !instance.isDestroyed) instance.value = null;
      });
    },
  });
  return (
    <div className="ti-picker" data-testid={testId}>
      <BryntumCombo
        ref={combo}
        cls="ti-field ti-combo"
        ariaLabel={placeholder}
        placeholder={options.length === 0 ? 'Nothing left to add' : placeholder}
        disabled={options.length === 0}
        items={items}
        displayField="text"
        valueField="value"
        editable
        autoExpand
        clearTextOnPickerHide
        filterOperator="*"
        caseSensitive={false}
        listItemTpl={renderOption as never}
        onChange={(event: { value: unknown; userAction?: boolean }) => handlers.current.change(event)}
      />
    </div>
  );
}
