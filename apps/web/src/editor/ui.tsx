/**
 * Building blocks shared by the contextual editor's sections, and the context every section reads.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { CurrencyCode, MemberRole } from '@collab/shared';
import { useState, type ReactNode } from 'react';
import type { WorkflowController, WorkflowViewState } from '../workflow/controller';

export interface Viewer {
  userId: string;
  role: MemberRole;
  canViewCosts: boolean;
  approvalLimitMinor: number;
}

export interface EditorContext {
  controller: WorkflowController;
  state: WorkflowViewState;
  viewer: Viewer;
  currency: CurrencyCode;
  project: ProjectModel;
  /** The last revision this browser applied; an evaluation older than this may be out of date. */
  revision: number;
  nameOf(userId: string | null): string | null;
}

export interface SectionProps {
  title: string;
  /** Stable id for tests and anchors, e.g. "booking". */
  id: string;
  aside?: ReactNode;
  children: ReactNode;
  /** Folds away under its title (details below the approval chain); `open` is how it starts. */
  foldable?: boolean;
  open?: boolean;
}

export function Section({ title, id, aside, children, foldable = false, open = true }: SectionProps) {
  const [isOpen, setOpen] = useState(open);
  if (foldable) {
    return (
      <details
        className="card editor-section is-foldable"
        data-testid={`section-${id}`}
        open={isOpen}
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="editor-section-header">
          <h3 id={`editor-${id}`}>
            <i className="fa fa-chevron-right editor-fold-icon" aria-hidden="true" />
            {title}
          </h3>
          {aside}
        </summary>
        <div className="editor-section-body">{children}</div>
      </details>
    );
  }
  return (
    <section className="card editor-section" data-testid={`section-${id}`} aria-labelledby={`editor-${id}`}>
      <header className="editor-section-header">
        <h3 id={`editor-${id}`} className="section-label">
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <dl className="editor-fields">{children}</dl>;
}

export function Field({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

const NOTE_TONES = { neutral: '', warn: ' is-warning', error: ' is-danger' } as const;

export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'error' }) {
  return <p className={`note editor-note${NOTE_TONES[tone]}`}>{children}</p>;
}

/** Relative time for recent events, the date otherwise. */
export function when(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}
