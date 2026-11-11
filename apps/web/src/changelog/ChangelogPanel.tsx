/**
 * The changelog side panel: one stream of everything that happened to the project, newest first.
 * Schedule edits (each person's, the assistant's), the fix being proposed, checked and approved, and
 * the PayPal payment, all from the server, so both people see the same log and it survives a reload.
 *
 * The panel owns the changelog's lifetime: opening it registers the stores on the project, folds the
 * session's revisions and builds the grid; closing it takes all of that away again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentEditDecisionRow, CurrencyCode } from '@collab/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReadyProjectSession } from '../app/project-session';
import type { WorkflowSnapshot } from '../workflow/api';
import { revisionReader, type RevisionReader } from './api';
import { attachChangelogStores, ChangelogFeed } from './feed';
import { createChangelogGrid, type ChangelogFilter, type ChangelogGrid } from './grid';
import type { ChangelogKind, CollabChangeLogTransaction } from './model';
import '../styles/changelog.css';

export interface ChangelogPanelProps {
  client: Pick<SupabaseClient, 'from'>;
  session: Pick<ReadyProjectSession, 'project' | 'projectId' | 'load' | 'sync'>;
  /** The workflow snapshot the editor already keeps fresh (it also names the people). */
  workflow: WorkflowSnapshot | null;
  /** What people decided about the assistant's drafted changes (the assistant session keeps it fresh). */
  decisions?: readonly AgentEditDecisionRow[];
  canViewCosts: boolean;
  currency: CurrencyCode;
  onOpenTask(taskId: number): void;
  onClose(): void;
  /** Replaces the Supabase read (tests). */
  readRevisions?: RevisionReader;
}

const FILTERS: ReadonlyArray<{ id: ChangelogFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'plan', label: 'Plan' },
  { id: 'payment', label: 'Payments' },
  { id: 'costs', label: 'Costs' },
];

const EMPTY_TEXT: Readonly<Record<ChangelogFilter, string>> = {
  all: 'Nothing has happened yet. Edits to the plan, the fix and payments will show up here.',
  plan: 'Nobody has changed the plan yet.',
  fix: 'No fix has been proposed yet.',
  payment: 'No payment has been approved or sent yet.',
  costs: 'No cost, rental or payment has changed yet.',
};

type Counts = Record<ChangelogFilter, number>;
const NO_COUNTS: Counts = { all: 0, plan: 0, fix: 0, payment: 0, costs: 0 };

interface Live {
  feed: ChangelogFeed;
  grid: ChangelogGrid;
  catchUp(): void;
}

export function ChangelogPanel({ client, session, workflow, decisions, canViewCosts, currency, onOpenTask, onClose, readRevisions }: ChangelogPanelProps) {
  const { project, projectId, load } = session;
  const lastRevision = session.sync.lastRevision;
  const hostRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [filter, setFilter] = useState<ChangelogFilter>('all');
  const [counts, setCounts] = useState<Counts>(NO_COUNTS);
  const [error, setError] = useState<string | null>(null);

  // Bryntum keeps the callbacks it was configured with; these refs hand it the latest ones.
  const openTask = useRef(onOpenTask);
  openTask.current = onOpenTask;
  const target = useRef(lastRevision);
  target.current = lastRevision;
  const read = useMemo(() => readRevisions ?? revisionReader(client, projectId), [readRevisions, client, projectId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const stores = attachChangelogStores(project);
    const feed = new ChangelogFeed(stores.changes, { snapshot: load.snapshot, snapshotRevision: load.snapshot_revision, canViewCosts, currency, project });
    const grid = createChangelogGrid({ appendTo: host, project, people: new Map(), onOpenTask: (taskId) => openTask.current(taskId) });
    let disposed = false;

    const countKinds = () => {
      const next: Counts = { ...NO_COUNTS };
      for (const record of stores.changes.records as CollabChangeLogTransaction[]) {
        next.all += 1;
        next[record.kind as ChangelogKind] += 1;
        if (record.money) next.costs += 1;
      }
      setCounts(next);
    };
    const detachCount = stores.changes.on({ change: countKinds }) as unknown as (() => void) | undefined;

    // One read at a time; a newer revision arriving meanwhile triggers one more read afterwards.
    let reading = false;
    const catchUp = () => {
      if (disposed || reading || target.current <= feed.lastRevision) return;
      reading = true;
      read(feed.lastRevision)
        .then((rows) => {
          if (disposed) return;
          feed.ingestRevisions(rows);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          reading = false;
          if (!disposed && target.current > feed.lastRevision) setTimeout(catchUp, 1000);
        });
    };

    feed.ingestRevisions(load.revisions);
    countKinds();
    setLive({ feed, grid, catchUp });
    // Relative times ("5 min ago") age while the panel is open.
    const clock = setInterval(() => grid.refreshRows(), 30_000);
    return () => {
      disposed = true;
      clearInterval(clock);
      detachCount?.();
      grid.destroy();
      feed.destroy();
      stores.detach();
      setLive(null);
    };
  }, [project, load, read, canViewCosts, currency]);

  // Revisions applied by this browser since the session loaded are read back from the server.
  useEffect(() => {
    live?.catchUp();
  }, [live, lastRevision]);

  useEffect(() => {
    if (!live) return;
    live.feed.setWorkflow(workflow);
    live.grid.people = live.feed.people;
    live.grid.refreshRows();
  }, [live, workflow]);

  useEffect(() => {
    if (!live || !decisions) return;
    live.feed.setDecisions(decisions);
    live.grid.refreshRows();
  }, [live, decisions]);

  useEffect(() => {
    if (!live) return;
    live.grid.showKind(filter);
    (live.grid as unknown as { emptyText: string }).emptyText = EMPTY_TEXT[filter];
  }, [live, filter]);

  return (
    <aside className="changelog-panel" data-testid="changelog-panel" aria-label="Changelog">
      <header className="panel-head">
        <span className="changelog-heading-icon" aria-hidden="true">
          <i className="fa fa-clock-rotate-left" />
        </span>
        <div className="panel-head-text">
          <h2 className="panel-head-title">Changelog</h2>
          <p className="panel-head-sub">Everything that happened to this plan, newest first</p>
        </div>
        <div className="panel-head-actions">
          <button type="button" className="button is-quiet is-icon" title="Close the changelog" aria-label="Close the changelog" onClick={onClose}>
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="segmented changelog-filters" role="tablist" aria-label="Show">
        {FILTERS.filter((option) => option.id !== 'costs' || canViewCosts).map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={filter === option.id}
            className="changelog-filter"
            data-testid={`changelog-filter-${option.id}`}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
            <span className="changelog-count">{counts[option.id]}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className="note is-danger changelog-error" role="alert">
          <i className="fa fa-triangle-exclamation" aria-hidden="true" /> Could not load the latest changes. {error}
        </p>
      )}
      <div className="changelog-grid-host" ref={hostRef} data-testid="changelog-grid" />
    </aside>
  );
}
