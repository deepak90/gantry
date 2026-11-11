/**
 * Who Remy still owes an answer on a call (what shows her as "thinking"), and how long she waits in a room everyone
 * has left: a quiet turn must not leave her "thinking" after she has answered, and someone who calls back soon after
 * hanging up finds her still on the call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterAnswer, type Waiting } from '../src/waiting.ts';

const entry = (identity: string, at: number): Waiting => ({ identity, at, expiresAt: at + 45_000 });

describe('who Remy still owes an answer', () => {
  it('settles everything a person asked before, once a line answers them', () => {
    // Charlie asked one thing in three breaths (three turns, one of which ended quiet); Dana asked once in between.
    const waiting = [entry('charlie', 1), entry('dana', 2), entry('charlie', 3), entry('charlie', 4)];
    const { waiting: left, answered } = afterAnswer(waiting, 'charlie');
    expect(answered).toBe('charlie');
    expect(left.map((w) => w.identity)).toEqual(['dana']);
  });

  it('answers whoever has waited longest when a line names nobody', () => {
    const { waiting: left, answered } = afterAnswer([entry('dana', 1), entry('charlie', 2)], undefined);
    expect(answered).toBe('dana');
    expect(left.map((w) => w.identity)).toEqual(['charlie']);
  });

  it('answers a person who was not waiting, and nobody when nobody was', () => {
    expect(afterAnswer([], 'charlie')).toEqual({ waiting: [], answered: 'charlie' });
    expect(afterAnswer([], undefined)).toEqual({ waiting: [], answered: null });
  });

  it('leaves the list it was given as it was', () => {
    const waiting = [entry('charlie', 1)];
    afterAnswer(waiting, 'charlie');
    expect(waiting).toHaveLength(1);
  });
});

describe('a room everyone has left', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the hosted Remy ten seconds, enough for a reloaded page to find her, and no longer: the minutes run while she waits', async () => {
    vi.stubEnv('GANTRY_HOSTED', '1');
    vi.resetModules();
    expect((await import('../src/config.ts')).EMPTY_ROOM_LEAVE_MS).toBe(10_000);
  });

  it('lets her go after five seconds anywhere else', async () => {
    vi.stubEnv('GANTRY_HOSTED', '');
    vi.resetModules();
    expect((await import('../src/config.ts')).EMPTY_ROOM_LEAVE_MS).toBe(5000);
  });
});
