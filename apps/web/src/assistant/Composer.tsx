/**
 * Where a person writes to the assistant. Above the box: the tasks selected in the plan, which go
 * along with the message ("what is wrong with this task?" means these), each of which can be taken
 * off. Below it: how the assistant's drafted changes apply for this person.
 *   Always ask     nothing changes until they press Apply (Decline is recorded in the changelog)
 *   Ask if risky   small changes apply once checked; deletions, unlinking, handover moves and big
 *                  edits wait for Apply
 *   Auto-apply     every change applies as soon as it is checked
 * Approvals and payments always wait for the person's own click, whatever the switch says.
 */
import type { ApprovalMode, SelectedTask } from '@collab/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { ASSISTANT_NAME, AssistantName } from './identity';

export const APPROVAL_MODES: ReadonlyArray<{ id: ApprovalMode; label: string; icon: string; hint: string }> = [
  { id: 'ask', label: 'Always ask', icon: 'hand', hint: 'Nothing changes until you press Apply. Declining is recorded in the changelog.' },
  { id: 'risky', label: 'Ask if risky', icon: 'shield-halved', hint: 'Small changes go in once checked. Deleting, unlinking, moving the handover or touching many tasks waits for you.' },
  { id: 'auto', label: 'Auto-apply', icon: 'bolt', hint: `Every change ${ASSISTANT_NAME} drafts for you goes in as soon as it is checked. Approvals and payments still wait for you.` },
];

export interface ComposerProps {
  /** No approval switch: drafted changes always ask. */
  quiet?: boolean;
  sending: boolean;
  selected: readonly SelectedTask[];
  excluded: ReadonlySet<number>;
  approvalMode: ApprovalMode;
  onToggleTask(taskId: number): void;
  onShowTask(taskId: number): void;
  onApprovalMode(mode: ApprovalMode): void;
  onSend(text: string): Promise<boolean>;
}

const MAX_CHIPS = 6;

export function Composer({ quiet = false, sending, selected, excluded, approvalMode, onToggleTask, onShowTask, onApprovalMode, onSend }: ComposerProps) {
  const [text, setText] = useState('');
  const assistantName = useContext(AssistantName);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(140, element.scrollHeight)}px`;
  }, [text]);
  const submit = async () => {
    if (!text.trim() || sending) return;
    const value = text;
    setText('');
    if (!(await onSend(value))) setText(value);
  };
  const included = selected.filter((task) => !excluded.has(task.id));
  const mode = APPROVAL_MODES.find((candidate) => candidate.id === approvalMode)!;

  return (
    <div className="assistant-compose">
      {selected.length > 0 ? (
        <div className="assistant-context" data-testid="assistant-context">
          <span className="assistant-context-label">{included.length === 0 ? 'Not about the selection' : `About ${included.length === 1 ? 'this task' : `these ${included.length}`}:`}</span>
          {selected.slice(0, MAX_CHIPS).map((task) => {
            const off = excluded.has(task.id);
            return (
              <span key={task.id} className={`pill ${off ? 'is-label is-off' : 'is-info'} assistant-context-chip`} data-testid="assistant-context-chip">
                <button type="button" className="assistant-context-name" onClick={() => onShowTask(task.id)} title="Show in the plan">
                  {task.wbs && <span className="assistant-context-wbs">{task.wbs}</span>}
                  {task.name}
                </button>
                <button
                  type="button"
                  className="assistant-context-toggle"
                  onClick={() => onToggleTask(task.id)}
                  aria-label={off ? `Ask about ${task.name} too` : `Leave ${task.name} out of the question`}
                  title={off ? 'Put back' : 'Leave out'}
                >
                  <i className={`fa fa-${off ? 'plus' : 'xmark'}`} aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {selected.length > MAX_CHIPS && <span className="assistant-context-more">+{selected.length - MAX_CHIPS} more</span>}
        </div>
      ) : (
        <p className="assistant-context-hint">
          <i className="fa fa-arrow-pointer" aria-hidden="true" /> Select tasks in the plan to ask about them.
        </p>
      )}
      <form
        className="assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={input}
          className="input"
          rows={1}
          value={text}
          placeholder={included.length === 1 ? `Ask about ${included[0]!.name}…` : included.length > 1 ? `Ask about these ${included.length} tasks…` : `Ask ${assistantName}…`}
          aria-label={`Message to ${assistantName}`}
          data-testid="assistant-input"
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button type="submit" className="button is-primary is-icon assistant-send" disabled={sending || !text.trim()} aria-label="Send" data-testid="assistant-send">
          <i className={`fa fa-${sending ? 'spinner fa-spin' : 'arrow-up'}`} aria-hidden="true" />
        </button>
      </form>
      {!quiet && (
      <div className="assistant-mode" role="radiogroup" aria-label={`How ${assistantName}'s changes apply`} data-testid="assistant-approval-mode">
        <span className="section-label">Changes</span>
        <div className="segmented">
          {APPROVAL_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === approvalMode}
              title={option.hint}
              onClick={() => onApprovalMode(option.id)}
              data-testid={`assistant-mode-${option.id}`}
            >
              <i className={`fa fa-${option.icon}`} aria-hidden="true" />
              {option.label}
            </button>
          ))}
        </div>
      </div>
      )}
      {!quiet && <p className="field-hint assistant-mode-hint">{mode.hint}</p>}
    </div>
  );
}
