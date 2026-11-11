import type { SyncState } from '../sync/revision-sync';

export type SyncTone = 'ok' | 'busy' | 'warn' | 'error';

export interface SyncPresentation {
  tone: SyncTone;
  label: string;
  /** Shown as the badge tooltip. */
  detail: string;
}

/**
 * Maps RevisionSync state to the badge (badge states: synced, N pending, error with retry).
 * An error the engine caused (`recovery: 'reload'`) is presented as being out of sync: retrying
 * cannot help, the project has to be rebuilt from the server.
 */
export function describeSync(state: SyncState): SyncPresentation {
  const revision = `at revision ${state.lastRevision}`;
  if (state.status === 'error') {
    if (state.recovery === 'reload') {
      return {
        tone: 'error',
        label: 'Out of sync',
        detail: `${state.error ?? 'A revision could not be applied.'} Reload the project to rebuild it from the server.`,
      };
    }
    return { tone: 'error', label: 'Sync error', detail: state.error ?? 'The last revision was rejected.' };
  }
  if (state.pending > 0) {
    const detail = state.lastFailure ? `Retrying: ${state.lastFailure}` : `Sending ${state.pending} local change(s)…`;
    return { tone: 'busy', label: `${state.pending} pending`, detail };
  }
  if (state.connection === 'reconnecting') {
    return { tone: 'warn', label: 'Reconnecting…', detail: `Live updates interrupted; ${revision}` };
  }
  if (state.connection === 'closed') {
    return { tone: 'warn', label: 'Disconnected', detail: `Live updates closed; ${revision}` };
  }
  return { tone: 'ok', label: 'Synced', detail: `All changes saved, ${revision}` };
}

export interface SyncBadgeProps {
  state: SyncState;
  /** Re-attempts a rejected submission (`recovery: 'retry'`). */
  onRetry: () => void;
  /** Throws the client away and boots it again from load_project (`recovery: 'reload'`). */
  onReload: () => void;
}

export function SyncBadge({ state, onRetry, onReload }: SyncBadgeProps) {
  const { tone, label, detail } = describeSync(state);
  const reload = state.recovery === 'reload';
  return (
    <span
      className={`sync-badge sync-badge-${tone}`}
      data-testid="sync-badge"
      data-sync-status={state.status}
      data-recovery={state.recovery}
      data-connection={state.connection}
      data-pending={state.pending}
      title={detail}
      role="status"
      aria-live="polite"
    >
      <span className="sync-badge-dot" aria-hidden="true" />
      <span className="sync-badge-label">{label}</span>
      {tone === 'error' && (
        <button type="button" className="button is-sm sync-badge-retry" onClick={reload ? onReload : onRetry}>
          {reload ? 'Reload' : 'Retry'}
        </button>
      )}
    </span>
  );
}
