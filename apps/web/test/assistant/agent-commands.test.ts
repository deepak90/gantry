/**
 * Commands from the assistant, run by the right browser: the requester's own tab takes theirs at once; another
 * person's tab waits until the command is open to anyone; a lost claim, a stale command or one already taken is
 * left alone; what the executor reports goes back as the result (Remy's odds, here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommandRow } from '@collab/shared';
import { AgentCommandRunner, type CommandExecutor, type CommandTransport } from '../../src/assistant/agent-commands';

const ME = '00000000-0000-4000-8000-000000000011';
const OTHER = '00000000-0000-4000-8000-000000000012';
const ID = '00000000-0000-4000-8000-0000000000c1';
const NOW = Date.parse('2026-11-10T14:00:00Z');

function command(overrides: Partial<AgentCommandRow> = {}): AgentCommandRow {
  return {
    id: ID,
    project_id: '00000000-0000-4000-8000-000000000002',
    type: 'schedule_odds',
    args: { pay: 'pay_run' },
    required_revision: null,
    executor_session: null,
    status: 'pending',
    result: null,
    requested_by: ME,
    created_at: new Date(NOW).toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function setup(row: AgentCommandRow, options: { claim?: 'ok' | 'lost'; outcome?: { ok: boolean; result: object } | Error } = {}) {
  const completed: { id: string; status: string; result: unknown }[] = [];
  const transport: CommandTransport = {
    loadCommand: vi.fn(async () => row),
    claim: vi.fn(async () => {
      if (options.claim === 'lost') throw new Error('already running');
      return { ...row, status: 'running' as const };
    }),
    complete: vi.fn(async (id, status, result) => {
      completed.push({ id, status, result });
    }),
  };
  const executor = vi.fn<CommandExecutor>(async () => {
    if (options.outcome instanceof Error) throw options.outcome;
    return (options.outcome ?? { ok: true, result: { message: 'ran' } }) as { ok: boolean; result: object };
  });
  const runner = new AgentCommandRunner({ transport, executor: () => executor, userId: ME, now: () => NOW, jitter: () => 0, onWarning: () => undefined });
  return { runner, transport, executor, completed };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AgentCommandRunner', () => {
  it('runs the requester’s own command at once and reports the result', async () => {
    const { runner, executor, completed } = setup(command());
    runner.heard(ID, 'pending');
    await settle();
    expect(executor).toHaveBeenCalledWith('schedule_odds', { pay: 'pay_run' });
    expect(completed).toEqual([{ id: ID, status: 'succeeded', result: { message: 'ran' } }]);
    // Hearing about it again changes nothing.
    runner.heard(ID, 'pending');
    await settle();
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('takes over somebody else’s command only once it is open to anyone', async () => {
    const { runner, transport, executor } = setup(command({ requested_by: OTHER }));
    runner.heard(ID, 'pending');
    await settle();
    expect(transport.claim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(transport.claim).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('leaves a command another tab claimed, one that is not pending, and one that is stale', async () => {
    const lost = setup(command(), { claim: 'lost' });
    lost.runner.heard(ID, 'pending');
    await settle();
    expect(lost.executor).not.toHaveBeenCalled();

    const running = setup(command());
    running.runner.heard(ID, 'running');
    await settle();
    expect(running.transport.loadCommand).not.toHaveBeenCalled();

    const stale = setup(command({ created_at: new Date(NOW - 120_000).toISOString() }));
    stale.runner.heard(ID, 'pending');
    await settle();
    expect(stale.transport.claim).not.toHaveBeenCalled();
  });

  it('reports a failure in the person’s browser, and refuses a command it does not know', async () => {
    const failing = setup(command(), { outcome: { ok: false, result: { message: 'The plan is not open in this browser.' } } });
    failing.runner.heard(ID, 'pending');
    await settle();
    expect(failing.completed[0]).toMatchObject({ status: 'failed', result: { message: 'The plan is not open in this browser.' } });

    const thrown = setup(command(), { outcome: new Error('The runs were stopped before they finished.') });
    thrown.runner.heard(ID, 'pending');
    await settle();
    expect(thrown.completed[0]).toMatchObject({ status: 'failed', result: { message: 'The runs were stopped before they finished.' } });

    const unknown = setup(command({ type: 'approve_payment' }));
    unknown.runner.heard(ID, 'pending');
    await settle();
    expect(unknown.executor).not.toHaveBeenCalled();
    expect(unknown.completed[0]).toMatchObject({ status: 'rejected' });
  });
});

describe('on a call', () => {
  it('the host’s tab takes anyone’s command as soon as it may, so the odds fall on the screen everyone watches', async () => {
    const row = command({ requested_by: OTHER });
    const completed: { status: string }[] = [];
    const transport: CommandTransport = {
      loadCommand: vi.fn(async () => row),
      claim: vi.fn(async () => ({ ...row, status: 'running' as const })),
      complete: vi.fn(async (_id, status) => {
        completed.push({ status });
      }),
    };
    const executor = vi.fn<CommandExecutor>(async () => ({ ok: true, result: { message: 'ran' } }));
    const runner = new AgentCommandRunner({ transport, executor: () => executor, userId: ME, now: () => NOW, jitter: () => 60_000, onWarning: () => undefined, takesAll: () => true });
    runner.heard(ID, 'pending');
    await settle();
    // The database keeps it the asker's for its first seconds; then the host claims it, with no jitter.
    expect(transport.claim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_200);
    await settle();
    await runner.idle();
    expect(transport.claim).toHaveBeenCalledTimes(1);
    expect(completed).toEqual([{ status: 'succeeded' }]);
  });

  it('a tab with no executor (on the call, not its host) leaves even its own command to the host', async () => {
    const row = command();
    const transport: CommandTransport = { loadCommand: vi.fn(async () => row), claim: vi.fn(async () => row), complete: vi.fn(async () => undefined) };
    const runner = new AgentCommandRunner({ transport, executor: () => null, userId: ME, now: () => NOW, jitter: () => 0, onWarning: () => undefined });
    runner.heard(ID, 'pending');
    await settle();
    await runner.idle();
    expect(transport.claim).not.toHaveBeenCalled();
  });
});

describe('Remy’s screen actions', () => {
  const show = { action: 'site_view', open: true };

  it('run in the requester’s own tab, the executor told the command’s type', async () => {
    const { runner, executor, completed } = setup(command({ type: 'ui_action', args: show }), { outcome: { ok: true, result: { ui: { did: 'Opened the site view.' } } } });
    runner.heard(ID, 'pending');
    await settle();
    await runner.idle();
    expect(executor).toHaveBeenCalledWith('ui_action', show);
    expect(completed[0]).toMatchObject({ status: 'succeeded', result: { ui: { did: 'Opened the site view.' } } });
  });

  it('are never taken over by somebody else’s tab, on a call either: they would move a screen nobody asked to move', async () => {
    const row = command({ type: 'ui_action', args: show, requested_by: OTHER });
    const transport: CommandTransport = { loadCommand: vi.fn(async () => row), claim: vi.fn(async () => row), complete: vi.fn(async () => undefined) };
    const executor = vi.fn<CommandExecutor>(async () => ({ ok: true, result: {} }));
    const runner = new AgentCommandRunner({ transport, executor: () => executor, userId: ME, now: () => NOW, jitter: () => 0, onWarning: () => undefined, takesAll: () => true });
    runner.heard(ID, 'pending');
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(transport.claim).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it('a call guest’s tab still runs its own: the executor is asked by type', async () => {
    const row = command({ type: 'ui_action', args: show });
    const transport: CommandTransport = { loadCommand: vi.fn(async () => row), claim: vi.fn(async () => ({ ...row, status: 'running' as const })), complete: vi.fn(async () => undefined) };
    const executor = vi.fn<CommandExecutor>(async () => ({ ok: true, result: { ui: { did: 'Done.' } } }));
    const runner = new AgentCommandRunner({ transport, executor: (type) => (type === 'ui_action' ? executor : null), userId: ME, now: () => NOW, jitter: () => 0, onWarning: () => undefined });
    runner.heard(ID, 'pending');
    await settle();
    await runner.idle();
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

