/**
 * The hosted site counts the invoices a person sends and the rentals they pay, once each, in their own tab only, and
 * not again for what was already done when the workspace opened.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionsBy, useActionReports } from '../../src/copy/useActionReports';
import type { WorkflowSnapshot } from '../../src/workflow/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoice = (id: string, status: string, sentBy: string | null) => ({ id, status, sent_by: sentBy, amount_minor: 12_540_000, currency: 'USD' });
const payment = (id: string, status: string, by: string | null) => ({ id, status, authorized_by: by, amount_minor: 1_140_000, currency: 'USD' });
const snapshot = (invoices: unknown[], payments: unknown[]) => ({ invoices, payments }) as unknown as WorkflowSnapshot;

describe('actionsBy', () => {
  it('lists the invoices this person sent and the rentals they paid, nobody else’s', () => {
    const shown = snapshot(
      [invoice('i1', 'sent', 'me'), invoice('i2', 'draft', 'me'), invoice('i3', 'paid', 'me'), invoice('i4', 'sent', 'chris')],
      [payment('p1', 'succeeded', 'me'), payment('p2', 'submitted', 'me'), payment('p3', 'succeeded', 'chris')],
    );
    expect(actionsBy(shown, 'me')).toEqual([
      { id: 'invoice:i1', event: 'invoice_sent', props: { amount: 125_400, currency: 'USD' } },
      { id: 'invoice:i3', event: 'invoice_sent', props: { amount: 125_400, currency: 'USD' } },
      { id: 'payment:p1', event: 'rental_paid', props: { amount: 11_400, currency: 'USD' } },
    ]);
  });
});

describe('useActionReports', () => {
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
  });

  function Probe({ shown, send, enabled = true }: { shown: WorkflowSnapshot | null; send: (event: never, props?: never) => void; enabled?: boolean }) {
    useActionReports(enabled, shown, 'me', send as never);
    return null;
  }

  it('counts each new one once, and not what was there when it opened', () => {
    const send = vi.fn();
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe shown={null} send={send} />));
    act(() => root!.render(<Probe shown={snapshot([invoice('old', 'sent', 'me')], [])} send={send} />));
    expect(send).not.toHaveBeenCalled();

    act(() => root!.render(<Probe shown={snapshot([invoice('old', 'sent', 'me'), invoice('new', 'sent', 'me')], [payment('p1', 'submitted', 'me')])} send={send} />));
    act(() => root!.render(<Probe shown={snapshot([invoice('old', 'sent', 'me'), invoice('new', 'paid', 'me')], [payment('p1', 'succeeded', 'me')])} send={send} />));
    expect(send.mock.calls).toEqual([
      ['invoice_sent', { amount: 125_400, currency: 'USD' }],
      ['rental_paid', { amount: 11_400, currency: 'USD' }],
    ]);
  });

  it('counts nothing when switched off', () => {
    const send = vi.fn();
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe enabled={false} shown={snapshot([], [])} send={send} />));
    act(() => root!.render(<Probe enabled={false} shown={snapshot([invoice('new', 'sent', 'me')], [])} send={send} />));
    expect(send).not.toHaveBeenCalled();
  });
});
