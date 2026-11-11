/**
 * The panel end to end in jsdom: the real VersionGrid over the project's changelog store, fed from a
 * fake revision reader and the workflow snapshot.
 */
import type { LoadProjectResult, ProjectInlineData, ProjectRevisionRow } from '@collab/shared';
import { Widget, type ProjectModel, type Store } from '@bryntum/gantt';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangelogPanel, type ChangelogPanelProps } from '../../src/changelog/ChangelogPanel';
import { CHANGELOG_STORE_ID } from '../../src/changelog/feed';
import type { ChangelogGrid } from '../../src/changelog/grid';
import { createProjectModel, loadCollaborativeProject } from '../../src/gantt/project';
import type { SyncState } from '../../src/sync/revision-sync';
import { CHRIS, PRIYA, nextFrame, revisionRow, scheduledSnapshot, shimFonts, workflowSnapshot } from './helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
shimFonts();

function move(no: number, taskId: number, day: string, actor = PRIYA): ProjectRevisionRow {
  const update = { id: taskId, startDate: `${day}T00:00:00` };
  // After the workflow fixture's events, so the plan edits are the newest rows (the grid renders the top rows).
  return revisionRow(no, { tasks: { $input: { updated: [update] }, updated: [update] } }, { actor_user_id: actor, created_at: `2026-10-22T11:0${no}:00.000Z` });
}

describe('ChangelogPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectModel;
  let snapshot: ProjectInlineData;
  let server: ProjectRevisionRow[];
  let props: ChangelogPanelProps;

  const sync = (lastRevision: number): SyncState => ({ status: 'synced', pending: 0, lastRevision, connection: 'connected' });
  const gridInstance = () => Widget.fromElement(host.querySelector<HTMLElement>('.b-version-grid')!, 'versiongrid') as unknown as ChangelogGrid;
  const text = () => host.textContent ?? '';

  async function render(next: Partial<ChangelogPanelProps> = {}) {
    props = { ...props, ...next };
    await act(async () => {
      root.render(<ChangelogPanel {...props} />);
    });
    await act(async () => {
      await nextFrame(80);
    });
  }

  beforeEach(async () => {
    snapshot = await scheduledSnapshot();
    project = createProjectModel();
    await loadCollaborativeProject(project, snapshot, '00000000-0000-4000-8000-0000000000c1', '0');
    server = [move(1, 21, '2026-11-13'), move(2, 41, '2026-12-07', CHRIS), move(3, 31, '2026-11-25')];
    const load: LoadProjectResult = {
      project: { id: 'p', name: 'Riverside Clinic', currency: 'USD', handover_task_id: null },
      membership: { role: 'cm', can_view_costs: true, approval_limit_minor: 0 },
      snapshot,
      snapshot_revision: 0,
      current_revision: 2,
      revisions: server.slice(0, 2),
    };
    host = document.createElement('div');
    host.style.height = '600px';
    document.body.appendChild(host);
    root = createRoot(host);
    props = {
      client: { from: () => { throw new Error('not used'); } } as never,
      session: { project, projectId: 'p', load, sync: sync(2) },
      workflow: null,
      canViewCosts: true,
      currency: 'USD',
      onOpenTask: vi.fn(),
      onClose: vi.fn(),
      readRevisions: vi.fn(async (after: number) => server.filter((row) => row.revision_no > after)),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    project.destroy();
  });

  it('lists the session’s revisions, names people once the workflow loads, and catches up as revisions arrive', async () => {
    await render();
    expect(project.getCrudStore(CHANGELOG_STORE_ID)).toBeTruthy();
    expect(text()).toContain('Someone moved Steel delivery 1 day later');
    expect(props.readRevisions).not.toHaveBeenCalled();

    await render({ workflow: workflowSnapshot() });
    expect(text()).toContain('Priya moved Steel delivery 1 day later');
    expect(text()).toContain('Chris moved Partitions');
    expect(text()).toContain('PayPal confirmed $3,600.00 paid to Northgate Equipment Rental (PayPal fee $0.25)');

    // This browser applied revision 3: the panel reads it back from the server and adds it on top.
    await render({ session: { ...props.session, sync: sync(3) } });
    expect(props.readRevisions).toHaveBeenCalledWith(2);
    expect(text()).toContain('Priya moved Electrical rough-in');
    const descriptions = [...host.querySelectorAll('.changelog-entry')].map((element) => element.textContent ?? '');
    expect(descriptions.filter((line) => line.includes('Electrical rough-in'))).toHaveLength(1);
  });

  it('has no version menu or editing, filters by kind, and opens a task from its name', async () => {
    await render({ workflow: workflowSnapshot() });
    const instance = gridInstance();
    expect(instance.features.cellMenu).toBeFalsy();
    expect(instance.features.cellEdit).toBeFalsy();
    expect(instance.showVersions).toBe(false);
    expect(text()).not.toMatch(/Restore|Compare|Rename/);

    // Payments: only the PayPal side of the story, drawn as payment entries.
    await act(async () => {
      (host.querySelector('[data-testid="changelog-filter-payment"]') as HTMLButtonElement).click();
      await nextFrame(80);
    });
    const kinds = [...host.querySelectorAll('.changelog-entry')].map((element) => element.className);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((className) => className.includes('changelog-kind-payment'))).toBe(true);
    expect(host.querySelector('.changelog-tone-paypal .fa-paypal')).toBeTruthy();
    expect(host.querySelector('[data-testid="changelog-filter-payment"] .changelog-count')!.textContent).toBe('3');

    // Costs: what moved money (the payments here), not the moves that changed no amount.
    await act(async () => {
      (host.querySelector('[data-testid="changelog-filter-costs"]') as HTMLButtonElement).click();
      await nextFrame(80);
    });
    expect(text()).toContain('PayPal confirmed');
    expect(text()).not.toContain('moved Steel delivery');
    expect(Number(host.querySelector('[data-testid="changelog-filter-costs"] .changelog-count')!.textContent)).toBeGreaterThanOrEqual(3);

    await act(async () => {
      (host.querySelector('[data-testid="changelog-filter-plan"]') as HTMLButtonElement).click();
      await nextFrame(80);
    });
    const link =[...host.querySelectorAll<HTMLElement>('.changelog-link')].find((element) => element.textContent === 'Steel delivery')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await nextFrame(20);
    });
    expect(props.onOpenTask).toHaveBeenCalledWith(21);
  });

  it('expands an entry into Bryntum’s property rows with the Gantt’s field names', async () => {
    await render({ workflow: workflowSnapshot() });
    const instance = gridInstance();
    const row = (instance.store as Store).getById('t-rev-1');
    await act(async () => {
      await instance.expand(row);
      const action = (row as unknown as { children: { id: string }[] }).children[0]!;
      await instance.expand(action.id);
      await nextFrame(80);
    });
    const update = host.querySelector('.b-version-grid-property-update-desc')!;
    expect(update.querySelector('.b-version-grid-property-name')!.textContent).toBe('Start');
    expect(update.querySelector('.b-version-grid-property-before')!.textContent).toBe('Thu, Nov 12');
    expect(update.querySelector('.b-version-grid-property-after')!.textContent).toBe('Fri, Nov 13');
  });

  it('opens a payment’s facts in one step, and entries without details have nothing to open', async () => {
    const workflow = workflowSnapshot();
    await render({ workflow });
    const instance = gridInstance();
    const store = instance.store as Store;
    const paid = store.getById(`t-wf-pay-${workflow.payments[0]!.id}-paid`) as unknown as { isLeaf: boolean; children: { propertyUpdate?: { property: string; after: string } }[] };
    expect(paid.isLeaf).toBe(false);
    expect(paid.children.map((row) => row.propertyUpdate && [row.propertyUpdate.property, row.propertyUpdate.after])).toEqual([
      ['Amount', '$3,600.00'],
      ['PayPal fee', '$0.25'],
      ['PayPal reference', 'BATCH-7XK2'],
    ]);
    const approval = store.getById(`t-wf-approval-${workflow.approvals[2]!.id}`) as unknown as { isLeaf: boolean };
    expect(approval.isLeaf).toBe(true);
  });

  it('has no Costs tab for someone who may not see costs', async () => {
    await render({ canViewCosts: false, workflow: workflowSnapshot() });
    expect(host.querySelector('[data-testid="changelog-filter-costs"]')).toBeNull();
    expect(host.querySelector('[data-testid="changelog-filter-payment"]')).toBeTruthy();
  });

  it('takes the stores off the project when it closes', async () => {
    await render();
    await act(async () => root.render(<div />));
    expect(project.getCrudStore(CHANGELOG_STORE_ID)).toBeFalsy();
  });
});
