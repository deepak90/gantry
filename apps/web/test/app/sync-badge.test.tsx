import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncBadge, describeSync } from '../../src/app/SyncBadge';
import type { SyncState } from '../../src/sync/revision-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: SyncState = { status: 'synced', pending: 0, lastRevision: 7, connection: 'connected' };

describe('describeSync', () => {
  it('shows synced, pending with its count, reconnecting and errors in that order of precedence', () => {
    expect(describeSync(base)).toMatchObject({ tone: 'ok', label: 'Synced' });
    expect(describeSync({ ...base, status: 'pending', pending: 3 })).toMatchObject({ tone: 'busy', label: '3 pending' });
    expect(describeSync({ ...base, status: 'pending', pending: 1, lastFailure: 'Failed to fetch' })).toMatchObject({
      tone: 'busy',
      label: '1 pending',
      detail: 'Retrying: Failed to fetch',
    });
    expect(describeSync({ ...base, connection: 'reconnecting' })).toMatchObject({ tone: 'warn', label: 'Reconnecting…' });
    expect(describeSync({ ...base, connection: 'closed' })).toMatchObject({ tone: 'warn', label: 'Disconnected' });
    expect(
      describeSync({ ...base, status: 'error', recovery: 'retry', error: 'Revision local-3 was rejected by the server: calendars are read-only' }),
    ).toEqual({
      tone: 'error',
      label: 'Sync error',
      detail: 'Revision local-3 was rejected by the server: calendars are read-only',
    });
    // Pending work outranks a dropped connection: the user needs to know changes are not saved yet.
    expect(describeSync({ ...base, status: 'pending', pending: 2, connection: 'reconnecting' })).toMatchObject({ label: '2 pending' });
  });

  it('presents an engine failure as out of sync, to be fixed by a reload rather than a retry', () => {
    expect(describeSync({ ...base, status: 'error', recovery: 'reload', error: 'Failed to apply revision 8: engine exploded' })).toEqual({
      tone: 'error',
      label: 'Out of sync',
      detail: 'Failed to apply revision 8: engine exploded Reload the project to rebuild it from the server.',
    });
  });
});

describe('SyncBadge', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = undefined;
    }
    container?.remove();
  });

  it('offers Retry for a rejected submission and Reload when the engine refused a revision', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    const host = container;
    const calls: string[] = [];
    const render = (state: SyncState) =>
      act(async () => mounted.render(<SyncBadge state={state} onRetry={() => calls.push('retry')} onReload={() => calls.push('reload')} />));
    const badge = () => host.querySelector('[data-testid="sync-badge"]')!;
    const button = () => host.querySelector<HTMLButtonElement>('button');

    await render({ ...base, status: 'error', recovery: 'retry', error: 'Revision local-1 was rejected by the server: nope' });
    expect(badge().getAttribute('data-sync-status')).toBe('error');
    expect(badge().getAttribute('data-recovery')).toBe('retry');
    expect(button()?.textContent).toBe('Retry');
    await act(async () => button()!.click());
    expect(calls).toEqual(['retry']);

    await render({ ...base, status: 'error', recovery: 'reload', error: 'Failed to apply revision 8: engine exploded' });
    expect(badge().getAttribute('data-recovery')).toBe('reload');
    expect(host.querySelector('.sync-badge-label')?.textContent).toBe('Out of sync');
    expect(button()?.textContent).toBe('Reload');
    await act(async () => button()!.click());
    expect(calls).toEqual(['retry', 'reload']);

    await render(base);
    expect(badge().getAttribute('data-sync-status')).toBe('synced');
    expect(badge().hasAttribute('data-recovery')).toBe(false);
    expect(button()).toBeNull();
  });
});
