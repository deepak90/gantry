/**
 * The walkthrough runner: one step per Next, in order; Next ignored while a step runs; a failed step
 * marked and tried again after the project is put back; Previous stops a running step and puts the
 * project back as it was before it; Start over goes back to the beginning.
 */
import { describe, expect, it, vi } from 'vitest';
import { RailRunner, type RailHost } from '../../src/rails/runner';
import type { RailContext, RailStep } from '../../src/rails/types';
import { sleep } from '../../src/rails/wait';

function hostFor(log: string[]): RailHost {
  return {
    makeContext: (signal) =>
      ({
        hand: null,
        signal,
        app: null,
        wait: async () => null,
        pause: (ms: number) => sleep(ms, signal),
      }) as unknown as RailContext,
    restore: async (index) => {
      log.push(`restore ${index}`);
    },
    checkpoint: (index) => {
      log.push(`checkpoint ${index}`);
    },
  };
}

function step(key: string, log: string[], run?: (context: RailContext) => Promise<void>): RailStep {
  return {
    key,
    label: key,
    caption: { lead: key, text: '' },
    run:
      run ??
      (async () => {
        log.push(`run ${key}`);
      }),
  };
}

describe('the walkthrough runner', () => {
  it('runs one step per press of Next, in order, and does nothing after the last', async () => {
    const log: string[] = [];
    const runner = new RailRunner([step('a', log), step('b', log)], hostFor(log));
    expect(runner.state).toEqual({ index: -1, status: 'ready', error: null });
    await runner.next();
    expect(runner.state).toEqual({ index: 0, status: 'done', error: null });
    await runner.next();
    await runner.next();
    expect(log).toEqual(['run a', 'checkpoint 0', 'run b', 'checkpoint 1']);
    expect(runner.state).toEqual({ index: 1, status: 'done', error: null });
  });

  it('ignores Next while a step runs', async () => {
    const log: string[] = [];
    let finish = () => {};
    const slow = step('slow', log, () => new Promise<void>((resolve) => ((finish = resolve), log.push('run slow'))));
    const runner = new RailRunner([slow, step('b', log)], hostFor(log));
    const first = runner.next();
    void runner.next();
    await vi.waitFor(() => expect(log).toContain('run slow'));
    void runner.next();
    finish();
    await first;
    expect(log).toEqual(['run slow', 'checkpoint 0']);
    expect(runner.state).toEqual({ index: 0, status: 'done', error: null });
  });

  it('marks a step that fails, and Next puts the project back and tries it again', async () => {
    const log: string[] = [];
    let tries = 0;
    const flaky = step('flaky', log, async () => {
      tries += 1;
      if (tries === 1) throw new Error('Waited 20 s for the drafted package');
      log.push('run flaky');
    });
    const runner = new RailRunner([flaky], hostFor(log));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runner.next();
    quiet.mockRestore();
    expect(runner.state).toEqual({ index: 0, status: 'failed', error: 'Waited 20 s for the drafted package' });
    await runner.next();
    expect(log).toEqual(['restore 0', 'run flaky', 'checkpoint 0']);
    expect(runner.state).toEqual({ index: 0, status: 'done', error: null });
  });

  it('Previous stops a running step part way and puts the project back as it was before it', async () => {
    const log: string[] = [];
    const long = step('long', log, async ({ pause }) => {
      log.push('start long');
      await pause(60_000);
      log.push('end long');
    });
    const runner = new RailRunner([step('a', log), long], hostFor(log));
    await runner.next();
    const running = runner.next();
    await vi.waitFor(() => expect(log).toContain('start long'));
    await runner.previous();
    await running;
    expect(log).toEqual(['run a', 'checkpoint 0', 'start long', 'restore 1']);
    expect(runner.state).toEqual({ index: 0, status: 'done', error: null });
  });

  it('Previous from the first step goes back to the start, and Start over does too', async () => {
    const log: string[] = [];
    const runner = new RailRunner([step('a', log), step('b', log)], hostFor(log));
    await runner.next();
    await runner.previous();
    expect(runner.state).toEqual({ index: -1, status: 'ready', error: null });
    await runner.next();
    await runner.next();
    await runner.startOver();
    expect(runner.state).toEqual({ index: -1, status: 'ready', error: null });
    expect(log).toEqual(['run a', 'checkpoint 0', 'restore 0', 'run a', 'checkpoint 0', 'run b', 'checkpoint 1', 'restore 0']);
  });

  it('tells its listeners each time the state changes', async () => {
    const log: string[] = [];
    const runner = new RailRunner([step('a', log)], hostFor(log));
    const seen: string[] = [];
    runner.subscribe((state) => seen.push(`${state.index}:${state.status}`));
    await runner.next();
    expect(seen).toEqual(['0:running', '0:running', '0:done']);
  });
});
