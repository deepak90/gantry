import { describe, expect, it } from 'vitest';
import { HOLD_MS, holdOf, minutesHold, refusalCode, UNAVAILABLE, type Refusal } from '../../src/call/hold';
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
    expect(hold).toMatchObject({ code: 'remy_busy', text: UNAVAILABLE, until: AT + HOLD_MS.remy_busy });
    expect(hold!.title).toMatch(/as many calls as she can take/);
    expect(holdOf(refused(409, 'remy_busy'), AT + HOLD_MS.remy_busy)).toBeNull();
  });

  it('holds for the rest of the visit once the session’s calls are used up, and never points at a way round it', () => {
    const hold = holdOf(refused(403, 'allowance_spent'), AT + 10 * 60 * 60 * 1000);
    expect(hold?.until).toBe(Infinity);
    expect(hold!.title).toBe("Remy is unavailable right now. This session's calls with Remy are used up. She's still in the chat, and the rest of the plan works as usual.");
    expect(hold!.title).not.toMatch(/start over|new session/i);
  });

  it('holds a few minutes while calls are off', () => {
    expect(holdOf(refused(403, 'calls_off'), AT)?.until).toBe(AT + HOLD_MS.calls_off);
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
    expect(view.held).toEqual({ text: 'Remy is unavailable', title: hold!.title });
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
    expect(view.held?.text).toBe('Remy is unavailable');
  });

  it('is as before once the hold is over', () => {
    const view = stripOf({ status: 'idle', error: null, room: room([]), remyHere: false, remyLate: false, hold: null });
    expect(view.held).toBeNull();
    expect(view.start?.label).toBe('Call Remy');
  });
});
