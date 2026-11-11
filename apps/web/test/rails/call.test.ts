/**
 * The call as the screen shows it: the assistant's line comes up a word at a time while it speaks; your
 * line comes up while it listens; it thinks while it waits; the takeaway waits until nobody is talking;
 * and every step goes your line first, then the step, then its takeaway.
 */
import { describe, expect, it } from 'vitest';
import { Call, wordsOf, wordTime } from '../../src/rails/call';
import type { RailContext } from '../../src/rails/types';
import { asSpoken } from '../../src/rails/useRail';

describe('the call', () => {
  it('brings the assistant’s line up a word at a time while it speaks', async () => {
    const call = new Call({ name: 'Remy', speed: 50 });
    const shown: number[] = [];
    const speaking: boolean[] = [];
    call.subscribe((state) => {
      if (state.words) shown.push(state.words.shown);
      speaking.push(state.speaking);
    });
    await call.say('Hi, I’m on. Drafting it now.');
    expect([...new Set(shown)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(speaking[0]).toBe(true);
    expect(call.state.speaking).toBe(false);
    expect(call.state.words).toEqual({ who: 'assistant', text: 'Hi, I’m on. Drafting it now.', shown: 6 });
  });

  it('pauses longer after a full stop than inside a sentence', () => {
    expect(wordTime('now.', 3)).toBeGreaterThan(wordTime('now', 3) + 300);
    expect(wordTime('order,', 3)).toBeGreaterThan(wordTime('order', 3));
    expect(wordsOf('  Do   it. ')).toEqual(['Do', 'it.']);
  });

  it('a newer line takes over from one still coming up', async () => {
    const call = new Call({ speed: 5 });
    const first = call.say('One two three four five six seven eight.');
    await call.say('Short.');
    await first;
    expect(call.state.words?.text).toBe('Short.');
    expect(call.state.speaking).toBe(false);
  });

  it('listens while your line comes up, then goes back to what it was doing', async () => {
    const call = new Call({ speed: 50 });
    await call.join();
    call.doing('working');
    const moods: string[] = [];
    call.subscribe((state) => moods.push(state.activity));
    await call.hear('Show me the crane.');
    expect(moods).toContain('listening');
    expect(call.state.activity).toBe('working');
    expect(call.state.words).toEqual({ who: 'you', text: 'Show me the crane.', shown: 4 });
  });

  it('shows a line heard already all at once', async () => {
    const call = new Call({ speed: 1 });
    await call.hear('Yes, add it.', undefined, { reveal: false });
    expect(call.state.words).toEqual({ who: 'you', text: 'Yes, add it.', shown: 3 });
    expect(call.state.youTalking).toBe(false);
  });

  it('thinks while it waits, then goes back to work', async () => {
    const call = new Call({ speed: 0 });
    await call.join();
    call.doing('working');
    let release!: (value: string) => void;
    const reply = call.think(new Promise<string>((resolve) => (release = resolve)));
    expect(call.state.activity).toBe('thinking');
    release('drafted');
    await expect(reply).resolves.toBe('drafted');
    expect(call.state.activity).toBe('working');
  });

  it('joins and leaves like someone on a call', async () => {
    const call = new Call({ speed: 0 });
    expect(call.state.presence).toBe('away');
    await call.join();
    expect(call.state.presence).toBe('here');
    await call.leave();
    expect(call.state.presence).toBe('away');
  });

  it('makes up a speaking level only while it speaks', async () => {
    const call = new Call({ speed: 50 });
    expect(call.assistantLevel()).toBe(0);
    const line = call.say('A few words here.');
    expect(call.assistantLevel(performance.now() + 120)).toBeGreaterThan(0);
    await line;
    expect(call.assistantLevel()).toBe(0);
  });

  it('shows the takeaway once nobody is talking, in place of the last line', async () => {
    const call = new Call({ speed: 0 });
    await call.say('All three floors are done.');
    call.settle({ lead: 'Done.', text: 'Every floor has it.' });
    expect(call.state.takeaway).toEqual({ lead: 'Done.', text: 'Every floor has it.' });
    expect(call.state.words).toBeNull();
  });
});

describe('a step, played like a call', () => {
  const caption = { lead: 'Lead.', text: 'Text.' };

  function contextFor(call: Call, sent: string[]): RailContext {
    return {
      call,
      signal: new AbortController().signal,
      app: {
        send: async (text: string, channel: string) => {
          sent.push(`${channel}: ${text}`);
          return true;
        },
      },
    } as unknown as RailContext;
  }

  it('says your line, sends it when the step asks, runs the step, then leaves its takeaway', async () => {
    const call = new Call({ speed: 0 });
    const sent: string[] = [];
    const order: string[] = [];
    const step = asSpoken(
      {
        key: 'ask',
        label: 'Ask',
        caption,
        you: { text: 'Draft a package', ask: true },
        async run() {
          order.push(`step, after ${sent.length} sent`);
        },
      },
      () => null,
    );
    await step.run(contextFor(call, sent));
    expect(sent).toEqual(['text: Draft a package']);
    expect(order).toEqual(['step, after 1 sent']);
    expect(call.state.takeaway).toEqual(caption);
  });

  it('a line the assistant just acts on is not sent', async () => {
    const call = new Call({ speed: 0 });
    const sent: string[] = [];
    await asSpoken({ key: 'yes', label: 'Yes', caption, you: { text: 'Yes, add it.' }, async run() {} }, () => null).run(contextFor(call, sent));
    expect(sent).toEqual([]);
  });

  it('in the voice mode, your line is what was heard, not the printed one, and goes as said aloud', async () => {
    const call = new Call({ speed: 0 });
    const sent: string[] = [];
    let seen = '';
    const heard = { take: async () => 'so who are we paying' };
    await asSpoken(
      {
        key: 'ask',
        label: 'Ask',
        caption,
        you: { text: 'So who do we pay?', ask: true },
        async run({ said }) {
          seen = said;
        },
      },
      () => heard,
    ).run(contextFor(call, sent));
    expect(sent).toEqual(['voice: so who are we paying']);
    expect(seen).toBe('so who are we paying');
  });

  it('in the voice mode, nothing heard means nothing sent and nothing done', async () => {
    const call = new Call({ speed: 0 });
    const sent: string[] = [];
    let ran = false;
    const step = asSpoken(
      {
        key: 'ask',
        label: 'Ask',
        caption,
        you: { text: 'Draft a package', ask: true },
        async run() {
          ran = true;
        },
      },
      () => ({ take: async () => '  ' }),
    );
    await expect(step.run(contextFor(call, sent))).rejects.toThrow('Nothing was heard');
    expect(sent).toEqual([]);
    expect(ran).toBe(false);
    expect(call.state.takeaway?.lead).toBe('Nothing was heard.');
  });
});
