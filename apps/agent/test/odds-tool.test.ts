/**
 * Remy's schedule_odds: the agent files a command for the person who asked, their browser runs the odds and
 * answers with what the runs gave, and the tool hands the model those numbers with ready words, never making one
 * up. A browser that doesn't answer, a malformed answer and a turn with nobody to ask are said as such.
 */
import { describe, expect, it } from 'vitest';
import type { OddsSummary } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';
import { TOOL_DEFINITIONS } from '../src/agent/brain';
import { CommandRunner } from '../src/agent/commands';
import { ODDS_TIMEOUT_MS, oddsWords, runOddsTool, type CommandPort } from '../src/agent/odds-tool';
import { SYSTEM_PROMPT } from '../src/agent/prompts';
import { ToolRefusal } from '../src/agent/refusal';
import { DATA_TOOL_DESCRIPTIONS, DataToolSchemas } from '../src/agent/tools';
import { FakeDb } from '../src/dev/fake';

/** Harbor's answer by its contract date, as the browser reports it (the numbers of apps/web's monte-carlo test). */
const HARBOR: OddsSummary = {
  contract_date: '2027-06-11',
  contract_from: 'deadline',
  planned_handover: '2027-05-27',
  runs: 1000,
  seed: 7,
  assumptions: 'Outdoor work in winter 90–135% · Indoor work 95–115% · Saturdays at 1.5× of $65 an hour, loaded · 1,000 runs · seed 7',
  pay: 'pay_run',
  on_time: 515,
  odds: 0.515,
  p50: '2027-06-11',
  p80: '2027-06-16',
  paid_when_due: { on_time: 839, odds: 0.839, p50: '2027-06-08', p80: '2027-06-11' },
  holds: [{ name: 'Footings paid on the Friday pay run', days_later_p50: 3, days_later_p80: 5, points: 32.4 }],
  threats: [
    { name: 'Curtain wall', correlation: 0.52 },
    { name: 'Erect steel and metal deck', correlation: 0.33 },
  ],
  ladder: [
    { step: 'Now, holds paid on the Friday pay run', on_time: 515, odds: 0.515, p50: '2027-06-11', cost_minor: 0, saturdays: 0 },
    { step: 'Pay for Footings when it falls due', on_time: 839, odds: 0.839, p50: '2027-06-08', cost_minor: 0, saturdays: 0 },
  ],
  on_copy: false,
};

const SPEAKER = { userId: SEED_IDS.cmUser, name: 'Deepak Jayaram' };

describe('schedule_odds', () => {
  it('runs in the browser of the person who asked and hands the model the runs’ numbers in words', async () => {
    const db = new FakeDb();
    const runner = new CommandRunner(db, db.projectId, { pollMs: 10_000 });
    db.onCommandInserted = (row) =>
      setTimeout(() => {
        row.status = 'succeeded';
        row.result = { odds: HARBOR };
        runner.notify(row.id);
      }, 5);
    const asked: { timeoutMs?: number }[] = [];
    const commands: CommandPort = {
      run: (type, args, requestedBy, revision, options) => {
        asked.push(options ?? {});
        return runner.run(type, args, requestedBy, revision, options);
      },
    };
    const result = (await runOddsTool('schedule_odds', { pay: 'pay_run' }, { speaker: SPEAKER, plan: { revision: 12 }, commands })) as Record<string, unknown>;
    expect(db.commands[0]).toMatchObject({ type: 'schedule_odds', args: { pay: 'pay_run' }, requested_by: SEED_IDS.cmUser, required_revision: 12 });
    expect(asked[0]!.timeoutMs).toBe(ODDS_TIMEOUT_MS);
    expect(result).toMatchObject({
      ran: true,
      contract: { date: '2027-06-11', text: 'Fri, Jun 11', from: 'deadline' },
      odds: { on_time: 515, runs: 1000, percent: '52%', words: 'about half the time', text: 'On time in 515 of 1,000 runs, 52%' },
      half_by: 'Fri, Jun 11',
      eight_in_ten_by: 'Wed, Jun 16',
      paid_when_due: { percent: '84%', words: 'about eight times out of ten', half_by: 'Tue, Jun 8' },
      assumptions: HARBOR.assumptions,
    });
    expect((result.ways_forward as unknown[])[1]).toMatchObject({ step: 'Pay for Footings when it falls due', odds: '84%', adds: 'nothing extra' });
    expect((result.threats as unknown[])[0]).toEqual({ task: 'Curtain wall', how_closely_the_handover_follows_it: '52%' });
    expect(String(result.question)).toMatch(/in Deepak Jayaram's browser/);
  });

  it('says so when the browser didn’t answer, or answered without the odds, rather than guessing', async () => {
    const quiet: CommandPort = { run: async () => ({ status: 'timeout', message: 'Nobody’s browser picked the request up in time.' }) };
    expect(await runOddsTool('schedule_odds', {}, { speaker: SPEAKER, plan: { revision: 0 }, commands: quiet })).toEqual({ ran: false, message: 'Nobody’s browser picked the request up in time.' });
    const empty: CommandPort = {
      run: async () => ({ status: 'succeeded', row: { id: '00000000-0000-4000-8000-0000000000c1', project_id: '00000000-0000-4000-8000-0000000000aa', type: 'schedule_odds', args: {}, required_revision: 0, executor_session: null, status: 'succeeded', result: { message: 'ok' }, requested_by: SEED_IDS.cmUser, created_at: new Date().toISOString(), completed_at: null } }),
    };
    expect(await runOddsTool('schedule_odds', {}, { speaker: SPEAKER, plan: { revision: 0 }, commands: empty })).toMatchObject({ ran: false });
  });

  it('needs someone to ask for it, and a way to reach their browser', async () => {
    await expect(runOddsTool('schedule_odds', {}, { speaker: null, plan: { revision: 0 }, commands: { run: async () => ({ status: 'timeout', message: '' }) } })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(runOddsTool('schedule_odds', {}, { speaker: SPEAKER, plan: { revision: 0 } })).rejects.toBeInstanceOf(ToolRefusal);
    await expect(runOddsTool('schedule_odds', { pay: 'tomorrow' }, { speaker: SPEAKER, plan: { revision: 0 } })).rejects.toBeInstanceOf(ToolRefusal);
  });

  it('puts shares in plain words', () => {
    expect(oddsWords(0.004)).toBe('almost never');
    // Low odds in a hundred: 2% isn't "one time out of ten".
    expect(oddsWords(0.01)).toBe('about 1 time in a hundred');
    expect(oddsWords(0.021)).toBe('about 2 times in a hundred');
    expect(oddsWords(0.074)).toBe('about 7 times in a hundred');
    expect(oddsWords(0.11)).toBe('about one time out of ten');
    expect(oddsWords(0.515)).toBe('about half the time');
    expect(oddsWords(0.839)).toBe('about eight times out of ten');
    expect(oddsWords(0.754)).toBe('about three times out of four');
    expect(oddsWords(0.953)).toBe('about nine times out of ten');
    expect(oddsWords(0.999)).toBe('almost every time');
  });

  it('is one of Remy’s tools, and her rules say to give only the numbers the runs gave, naming the question', () => {
    expect(DataToolSchemas).toHaveProperty('schedule_odds');
    expect(DATA_TOOL_DESCRIPTIONS.schedule_odds).toMatch(/thousand times/);
    expect(TOOL_DEFINITIONS.some((tool) => tool.name === 'schedule_odds')).toBe(true);
    expect(SYSTEM_PROMPT).toMatch(/Say only what schedule_odds gave/);
    expect(SYSTEM_PROMPT).toMatch(/waiting till Friday pushes the handover six days/);
    expect(SYSTEM_PROMPT).toMatch(/we make the deadline about half the time/);
  });

  it('waits as long as the call asks: the odds take longer than most commands', async () => {
    const db = new FakeDb();
    let clock = 0;
    // The browser is still running the odds at 50 ms (where the default wait gives up) and answers at 400 ms.
    const sleep = async (ms: number) => {
      clock += ms;
      const row = db.commands.at(-1);
      if (row && clock >= 400) {
        row.status = 'succeeded';
        row.result = { odds: HARBOR };
      }
    };
    db.onCommandInserted = (row) => {
      row.status = 'running';
    };
    const short = new CommandRunner(db, db.projectId, { pollMs: 10, timeoutMs: 50, now: () => clock, sleep });
    expect((await short.run('schedule_odds', {}, SEED_IDS.cmUser, 0)).status).toBe('timeout');
    clock = 0;
    const outcome = await short.run('schedule_odds', {}, SEED_IDS.cmUser, 0, { timeoutMs: 1_000 });
    expect(outcome.status).toBe('succeeded');
  });
});
