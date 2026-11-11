/**
 * Notes: free text everyone on the project sees, saved once when the box is left.
 */
import { setTaskNote } from './apply';
import type { TaskView } from './model';
import { Notice, useCommittedText, usePanel } from './ui';

export function NotesTab({ view }: { view: TaskView }) {
  const { project, run } = usePanel();
  const note = useCommittedText(view.note, (next) => run(() => setTaskNote(project, view.id, next)));
  return (
    <div className="ti-tab-body" data-testid="task-notes">
      <label className="field-label" htmlFor="task-note">
        Notes for everyone on the project
      </label>
      <textarea
        id="task-note"
        className="input ti-notes"
        data-testid="task-note"
        rows={9}
        placeholder="What should the other person know? Access, deliveries, inspections, who to call…"
        value={note.draft}
        onFocus={note.onFocus}
        onChange={(event) => note.setDraft(event.target.value)}
        onBlur={(event) => void note.save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            note.revert();
            event.currentTarget.blur();
          }
        }}
      />
      {note.changedElsewhere ? (
        <Notice icon="user-pen" tone="warn">
          Someone else changed this note while you were typing. Leaving the box saves your text over theirs; Esc keeps theirs.
        </Notice>
      ) : (
        <p className="field-hint">Saved when you click away. Esc undoes what you typed.</p>
      )}
    </div>
  );
}
