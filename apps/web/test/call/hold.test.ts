import { describe, expect, it } from 'vitest';
import { blockHold, HOLD_MS, holdOf, minutesHold, refusalCode, roomBlockOf, untilWords, type Refusal } from '../../src/call/hold';
import { spentTitle } from '../../src/call/minutes';
import { stripOf } from '../../src/call/view';

const AT = 1_000_000;
const refused = (status: number, code: string | null): Refusal => ({ status, code, message: 'The server’s words.', at: AT });

describe('what a refusal holds', () => {
  it('reads the server’s reason, and a bare 409 as Remy being busy', () => {
    expect(refusalCode({ status: 409, code: 'remy_busy' })).toBe('remy_busy');
    expect(refusalCode({ status: 403, code: 'allowance_spent' })).toBe('allowance_spent');
    expect(refusalCode({ status: 403, code: 'calls_off' })).toBe('calls_off');
    expect(refusalCode({ status: 409, code: null })).toBe('remy_busy');
    // Not on the project, a tab that lost its sign-in, or a reason it doesn't know: no hold.
    expect(refusalCode({ status: 403, code: null })).toBeNull();
    expect(refusalCode({ status: 403, code: 'something_else' })).toBeNull();
  });

  it('holds while Remy is busy, then lets the button be pressed again', () => {
    const hold = holdOf(refused(409, 'remy_busy'), AT + 1000);
    expect(hold).toMatchObject({ code: 'remy_busy', text: 'Remy is on other calls', until: AT + HOLD_MS.remy_busy });
    expect(hold!.title).toMatch(/as many calls as she can take/);
    expect(holdOf(refused(409, 'remy_busy'), AT + HOLD_MS.remy_busy)).toBeNull();
  });

  it('holds for the rest of the visit once the session’s calls are used up, and never points at a way round it', () => {
    const hold = holdOf(refused(403, 'allowance_spent'), AT + 10 * 60 * 60 * 1000);
    expect(hold?.until).toBe(Infinity);
    expect(hold!.text).toBe('No more calls this session');
    expect(hold!.title).toBe("This session's calls with Remy are used up. She's still in the chat, and the rest of the plan works as usual.");
    expect(hold!.title).not.toMatch(/start over|new session/i);
  });

  it('holds a few minutes while calls are off', () => {
    expect(holdOf(refused(403, 'calls_off'), AT)).toMatchObject({ text: 'Calls are off right now', until: AT + HOLD_MS.calls_off });
  });

  it('holds until the site’s day resets when it says so, in the person’s own time', () => {
    const until = AT + 3 * 3_600_000;
    const hold = holdOf({ ...refused(403, 'calls_paused'), until }, AT);
    expect(hold).toMatchObject({ code: 'calls_paused', text: `Calls paused until ${untilWords(until, AT)}`, until });
    expect(hold!.title).toMatch(/paused on the site until .+, when its daily limit resets\./);
    expect(holdOf({ ...refused(403, 'calls_paused'), until }, until)).toBeNull();
    // Without a time from the server: half an hour, then a press asks again.
    expect(holdOf(refused(403, 'calls_paused'), AT)?.until).toBe(AT + HOLD_MS.calls_paused);
  });

  it('is nothing without a refusal, or for one that isn’t about bringing her in', () => {
    expect(holdOf(null, AT)).toBeNull();
    expect(holdOf(refused(403, null), AT)).toBeNull();
  });
});

describe('used-up minutes', () => {
  it('hold the button for the rest of the visit, and say so on it, whether the site refused a call or said so first', () => {
    expect(refusalCode({ status: 403, code: 'minutes_spent' })).toBe('minutes_spent');
    expect(HOLD_MS.minutes_spent).toBe(Infinity);
    const hold = holdOf(refused(403, 'minutes_spent'), AT + 10 * 3_600_000);
    expect(hold).toMatchObject({ code: 'minutes_spent', text: 'No Remy minutes left', until: Infinity });
    expect(hold!.title).toMatch(/minutes with Remy on calls are used up/);
    expect(minutesHold(300_000)).toEqual({ code: 'minutes_spent', text: 'No Remy minutes left', title: spentTitle(300_000), until: Infinity });
  });

  it('leave nothing to start or join, even with a call going without her', () => {
    for (const people of [[], ['Chris Hale']]) {
      const view = stripOf({ status: 'idle', error: null, room: { up: true, people, remy: false }, remyHere: false, remyLate: false, hosted: true, hold: minutesHold(300_000) });
      expect(view).toMatchObject({ start: null, joining: false, note: null, held: { text: 'No Remy minutes left' } });
    }
  });
});

describe('the call button while held', () => {
  const room = (people: string[], remy = false) => ({ up: true, people, remy });
  const hold = holdOf(refused(403, 'allowance_spent'), AT);

  it('says Remy is unavailable, with why, when nobody is on a call', () => {
    const view = stripOf({ status: 'failed', error: 'The call isn’t available: …', room: room([]), remyHere: false, remyLate: false, hold });
    expect(view.held).toEqual({ text: 'No more calls this session', title: hold!.title });
    // The button says it; no second line repeats it.
    expect(view.note).toBeNull();
  });

  it('still lets people join a call that is going, without her, and says why she isn’t coming', () => {
    const view = stripOf({ status: 'idle', error: null, room: room(['Riley Brooks']), remyHere: false, remyLate: false, hold });
    expect(view.held).toBeNull();
    expect(view.start?.label).toBe('Join');
    expect(view.note).toEqual({ text: 'Remy unavailable', title: hold!.title });
  });

  it('shows her seat as unavailable on a call, instead of offering to call her in', () => {
    const view = stripOf({ status: 'connected', error: null, room: room(['Riley Brooks']), remyHere: false, remyLate: true, hold });
    expect(view.seat).toBe('held');
    expect(view.callRemy).toBe(false);
    expect(view.held?.text).toBe('No more calls this session');
  });

  it('is as before once the hold is over', () => {
    const view = stripOf({ status: 'idle', error: null, room: room([]), remyHere: false, remyLate: false, hold: null });
    expect(view.held).toBeNull();
    expect(view.start?.label).toBe('Call Remy');
  });
});

describe('the room route’s word, before anyone presses', () => {
  it('holds the button for as long as it says so, in the same words as a refusal', () => {
    const until = Date.UTC(2026, 10, 12);
    const now = Date.UTC(2026, 10, 11, 22, 59);
    expect(blockHold({ why: 'paused', what: 'starts', until }, now)).toMatchObject({ code: 'calls_paused', text: `Calls paused until ${untilWords(until, now)}`, until });
    expect(blockHold({ why: 'paused', what: 'spend', until: null }, now)).toMatchObject({ code: 'calls_paused', text: 'Calls paused for today' });
    expect(blockHold({ why: 'session', what: 'starts', until: null }, now)).toMatchObject({ code: 'allowance_spent', text: 'No more calls this session', until: Infinity });
    expect(blockHold({ why: 'session', what: 'turns', until: null }, now).title).toMatch(/answered as much as one session gets/);
    expect(blockHold({ why: 'busy', what: 'remy', until: null }, now)).toMatchObject({ code: 'remy_busy', text: 'Remy is on other calls' });
    expect(blockHold({ why: 'off', what: 'calls', until: null }, now)).toMatchObject({ code: 'calls_off', text: 'Calls are off right now' });
  });

  it('reads the route’s word when it is whole', () => {
    expect(roomBlockOf({ why: 'paused', what: 'starts', until: 5 })).toEqual({ why: 'paused', what: 'starts', until: 5 });
    expect(roomBlockOf({ why: 'busy', what: 'remy', until: null })).toEqual({ why: 'busy', what: 'remy', until: null });
    for (const odd of [null, 'paused', [], { why: 'later' }, { what: 'starts' }]) expect(roomBlockOf(odd)).toBeNull();
  });

  it('says the time where the person is, and when it is tomorrow there', () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime();
    expect(untilWords(new Date(2026, 10, 11, 16, 0).getTime(), now)).toBe('4:00 PM');
    expect(untilWords(new Date(2026, 10, 12, 16, 0).getTime(), now)).toBe('4:00 PM tomorrow');
  });
});
