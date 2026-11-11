/**
 * The call as the screen shows it: people read from LiveKit, one tile each (initials, their cursor color,
 * a ring while they speak, a mute badge, "AI voice" on simulated people), who hosts, what the header offers
 * before the call and while joining, and Remy's seat on the call bar while she isn't on the call.
 */
import { describe, expect, it } from 'vitest';
import { hostOf, humansOf, remyOf, personFrom, stripOf, tilesOf, type CallPerson, type RawParticipant } from '../../src/call/view';

const raw = (overrides: Partial<RawParticipant> = {}): RawParticipant => ({
  identity: 'deepak-tab',
  attributes: { name: 'Deepak Jayaram', color: '#695086', role: 'cm' },
  isAgent: false,
  isLocal: false,
  isSpeaking: false,
  micOn: true,
  joinedAt: 1000,
  ...overrides,
});

const deepak = personFrom(raw({ isLocal: true }));
const nora = personFrom(raw({ identity: 'nora-tab', attributes: { name: 'Nora Bennett', color: '#2563eb', role: 'cm' }, joinedAt: 2000, isSpeaking: true }));
const tom = personFrom(raw({ identity: 'tom-tab', attributes: { name: 'Tom Becker (sim)', color: '#0369a1', role: 'MEP coordinator', sim: 'true' }, joinedAt: 3000, micOn: false }));
const remy = personFrom(raw({ identity: 'remy', name: 'Remy', attributes: { name: 'Remy', 'lk.agent.state': 'listening' }, isAgent: true, joinedAt: 1500 }));
const recorder = personFrom(raw({ identity: 'recorder-1', attributes: {}, joinedAt: 500 }));

describe('the people on the call', () => {
  it('reads each person from their attributes', () => {
    expect(nora).toEqual<CallPerson>({
      identity: 'nora-tab',
      name: 'Nora Bennett',
      color: '#2563eb',
      role: 'cm',
      sim: false,
      isRemy: false,
      isLocal: false,
      speaking: true,
      micOn: true,
      joinedAt: 2000,
    });
    expect(tom.sim).toBe(true);
    expect(remy.isRemy).toBe(true);
  });

  it('knows Remy by her identity even before she says she is an agent', () => {
    expect(personFrom(raw({ identity: 'remy', attributes: {} })).isRemy).toBe(true);
    expect(personFrom(raw({ identity: 'remy', attributes: {} })).name).toBe('Remy');
  });

  it('falls back to the token’s name, then a plain word, and a neutral color', () => {
    expect(personFrom(raw({ attributes: {}, name: 'Nora B' })).name).toBe('Nora B');
    expect(personFrom(raw({ attributes: {} })).name).toBe('Someone');
    expect(personFrom(raw({ attributes: { name: 'X', color: 'red' } })).color).toBe('#46576c');
  });

  it('tells Remy and the recorder apart from the people', () => {
    const everyone = [deepak, nora, tom, remy, recorder];
    expect(humansOf(everyone).map((person) => person.identity)).toEqual(['deepak-tab', 'nora-tab', 'tom-tab']);
    expect(remyOf(everyone)?.identity).toBe('remy');
    expect(remyOf([deepak])).toBeNull();
  });
});

describe('who hosts the call', () => {
  it('is whoever has been on it longest, the one who started it', () => {
    expect(hostOf([tom, nora, remy, deepak])).toBe('deepak-tab');
  });

  it('passes to the next longest when the host leaves', () => {
    expect(hostOf([tom, nora, remy])).toBe('nora-tab');
  });

  it('is never Remy or a recorder, and is decided the same way in every tab', () => {
    expect(hostOf([remy, recorder])).toBeNull();
    const a = { ...nora, identity: 'b-tab', joinedAt: 5000 };
    const b = { ...nora, identity: 'a-tab', joinedAt: 5000 };
    expect(hostOf([a, b])).toBe('a-tab');
    expect(hostOf([b, a])).toBe('a-tab');
    // Someone whose join time isn't known yet goes after those whose is.
    expect(hostOf([{ ...nora, joinedAt: 0 }, tom])).toBe('tom-tab');
  });
});

describe('the tiles', () => {
  it('has one per person, in the order they joined, Remy aside', () => {
    expect(tilesOf([tom, remy, nora, deepak]).map((tile) => tile.identity)).toEqual(['deepak-tab', 'nora-tab', 'tom-tab']);
  });

  it('shows initials in the person’s cursor color, “You” for you and first names for the others', () => {
    const [you, her, him] = tilesOf([deepak, nora, tom]);
    expect(you).toMatchObject({ initials: 'DJ', label: 'Deepak', color: '#695086', isLocal: true });
    expect(her).toMatchObject({ initials: 'NB', label: 'Nora', color: '#2563eb', isLocal: false });
    expect(him).toMatchObject({ initials: 'TB', label: 'Tom' });
    expect(her!.ink).toMatch(/^var\(--ink/);
  });

  it('rings whoever speaks, badges whoever is muted, and says “AI voice” on a simulated person', () => {
    const [you, her, him] = tilesOf([deepak, nora, tom]);
    expect([you!.speaking, her!.speaking, him!.speaking]).toEqual([false, true, false]);
    expect([you!.muted, her!.muted, him!.muted]).toEqual([false, false, true]);
    expect([you!.tag, her!.tag, him!.tag]).toEqual([null, null, 'AI voice']);
  });

  it('says it all in words for the tooltip', () => {
    const [you, her, him] = tilesOf([deepak, nora, tom]);
    expect(you!.title).toBe('Deepak Jayaram (you)');
    expect(her!.title).toBe('Nora Bennett');
    expect(him!.title).toBe('Tom Becker, AI voice, muted');
  });
});

describe('what the call offers', () => {
  const room = (people: string[], remy = false) => ({ up: true, people, remy });

  it('offers “Call Remy” when nobody is on the call', () => {
    const view = stripOf({ status: 'idle', error: null, room: room([]), remyHere: false, remyLate: false });
    expect(view.start).toEqual({ label: 'Call Remy', title: 'Start a call with Remy. Everyone in this project can join.' });
    expect(view).toMatchObject({ joining: false, inCall: false, callRemy: false, note: null });
  });

  it('offers “Join” when someone is, saying who', () => {
    expect(stripOf({ status: 'idle', error: null, room: room(['Deepak Jayaram'], true), remyHere: false, remyLate: false }).start).toEqual({
      label: 'Join',
      title: 'Deepak Jayaram and Remy are on the call',
    });
    expect(stripOf({ status: 'idle', error: null, room: room(['Deepak Jayaram']), remyHere: false, remyLate: false }).start?.title).toBe('Deepak Jayaram is on the call');
  });

  it('says when the call server isn’t running, or the call failed', () => {
    expect(stripOf({ status: 'idle', error: null, room: { up: false, people: [], remy: false }, remyHere: false, remyLate: false }).note?.text).toBe('Call server off');
    const failed = stripOf({ status: 'failed', error: 'The call ended: the call server stopped.', room: null, remyHere: false, remyLate: false });
    expect(failed.note).toEqual({ text: 'Call unavailable', title: 'The call ended: the call server stopped.' });
    expect(failed.start?.label).toBe('Call Remy');
  });

  it('shows “Joining…” while it joins, then the call’s own buttons', () => {
    expect(stripOf({ status: 'joining', error: null, room: null, remyHere: false, remyLate: false })).toMatchObject({ start: null, joining: true, inCall: false });
    expect(stripOf({ status: 'connected', error: null, room: null, remyHere: true, remyLate: false })).toMatchObject({ start: null, joining: false, inCall: true, callRemy: false, note: null });
    expect(stripOf({ status: 'reconnecting', error: null, room: null, remyHere: true, remyLate: false }).note?.text).toBe('Reconnecting…');
  });

  it('offers to call Remy in once she is late, and not before', () => {
    expect(stripOf({ status: 'connected', error: null, room: null, remyHere: false, remyLate: false }).callRemy).toBe(false);
    expect(stripOf({ status: 'connected', error: null, room: null, remyHere: false, remyLate: true }).callRemy).toBe(true);
    expect(stripOf({ status: 'connected', error: null, room: null, remyHere: true, remyLate: true }).callRemy).toBe(false);
  });

  it('keeps Remy’s seat on the call bar: on her way, then an offer to call her in, and gone once she is on', () => {
    const seat = (remyHere: boolean, remyLate: boolean, status: 'connected' | 'reconnecting' | 'joining' | 'idle' = 'connected') =>
      stripOf({ status, error: null, room: null, remyHere, remyLate }).seat;
    expect(seat(false, false)).toBe('joining');
    expect(seat(false, true)).toBe('offer');
    expect(seat(false, true, 'reconnecting')).toBe('offer');
    expect(seat(true, false)).toBeNull();
    expect(seat(true, true)).toBeNull();
    // Off the call there is no bar to sit on.
    expect(seat(false, true, 'joining')).toBeNull();
    expect(seat(false, true, 'idle')).toBeNull();
  });
});
