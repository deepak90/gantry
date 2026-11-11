import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaveCall, type LeavingSteps } from '../src/leaving.ts';

function steps(overrides: Partial<LeavingSteps> = {}) {
  const done: string[] = [];
  const all: LeavingSteps = {
    mark: async () => {
      done.push('mark');
    },
    // Her sessions take their time closing: never waited for.
    close: () => new Promise<void>(() => done.push('close')),
    disconnect: async () => {
      done.push('disconnect');
    },
    shutdown: () => {
      done.push('shutdown');
    },
    onError: (step) => {
      done.push(`trouble ${step}`);
    },
    ...overrides,
  };
  return { all, done };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Remy leaving a call', () => {
  it('says she is leaving, then leaves the room before her sessions have closed, then ends the job', async () => {
    const { all, done } = steps();
    await leaveCall(all, { markMs: 1000 });
    expect(done).toEqual(['mark', 'close', 'disconnect', 'shutdown']);
  });

  it('deletes the room first when the call ends for everyone', async () => {
    const { all, done } = steps({
      deleteRoom: async () => {
        done.push('delete room');
      },
    });
    await leaveCall(all, { markMs: 1000 });
    expect(done).toEqual(['mark', 'delete room', 'close', 'disconnect', 'shutdown']);
  });

  it('leaves anyway when the call server is slow to take her mark, or refuses it', async () => {
    const slow = steps({ mark: () => new Promise<void>(() => undefined) });
    const leaving = leaveCall(slow.all, { markMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await leaving;
    expect(slow.done).toEqual(['trouble mark_late', 'close', 'disconnect', 'shutdown']);

    const refused = steps({ mark: async () => Promise.reject(new Error('not connected')) });
    await leaveCall(refused.all, { markMs: 1000 });
    expect(refused.done).toEqual(['trouble mark', 'close', 'disconnect', 'shutdown']);
  });

  it('ends the job even when the room can’t be deleted or left', async () => {
    const { all, done } = steps({
      deleteRoom: async () => Promise.reject(new Error('404')),
      disconnect: async () => Promise.reject(new Error('gone')),
    });
    await leaveCall(all, { markMs: 1000 });
    expect(done).toEqual(['mark', 'trouble delete_room', 'close', 'trouble disconnect', 'shutdown']);
  });
});
