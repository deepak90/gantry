/**
 * Remy's face kept in step with the real call: she arrives and goes with her worker, her aura follows her
 * own track while she speaks, the orbs turn while she thinks, the captions are the call's own with who said
 * them (by name and in their color, a speaker's lines running together), and the face is handed back as it
 * was when the call ends.
 */
import { describe, expect, it, vi } from 'vitest';
import { followRemy, type FinalLine } from '../../src/call/face';
import { REMY } from '../../src/call/protocol';
import type { Caption, CallSession, CallSnapshot, RemyDoing } from '../../src/call/session';
import { personFrom } from '../../src/call/view';
import { Call } from '../../src/rails/call';

const ME = 'deepak-tab';
const NORA = 'nora-tab';

const COLORS: Record<string, string> = { [ME]: '#695086', [NORA]: '#2563eb' };

const person = (identity: string, name: string, local = false) =>
  personFrom({ identity, attributes: { name, color: COLORS[identity] ?? '#0369a1', role: 'cm' }, isAgent: identity === REMY, isLocal: local, isSpeaking: false, micOn: true, joinedAt: 1 });

function fakeSession() {
  const listeners = new Set<() => void>();
  const captionListeners = new Set<(caption: Caption) => void>();
  let snapshot: CallSnapshot = { status: 'idle', error: null, mic: 'off', micError: null, me: ME, people: [], remy: null, remyStuck: false, host: null, captions: [], audioBlocked: false, endsAt: null };
  const levels = new Map<string, number>([
    [REMY, 0.7],
    [NORA, 0.4],
  ]);
  const session = {
    get snapshot() {
      return snapshot;
    },
    get inCall() {
      return snapshot.status === 'connected' || snapshot.status === 'reconnecting';
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCaption: (listener: (caption: Caption) => void) => {
      captionListeners.add(listener);
      return () => captionListeners.delete(listener);
    },
    level: (identity: string) => levels.get(identity) ?? 0,
  };
  return {
    session: session as unknown as CallSession,
    update(patch: Partial<CallSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((listener) => listener());
    },
    caption(identity: string, text: string, final = true, segment = 1) {
      captionListeners.forEach((listener) => listener({ segmentId: `${identity}-${segment}`, identity, text, final, at: Date.now() }));
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Remy’s face on the call', () => {
  it('arrives with her worker and goes with it, her aura on her own voice meanwhile', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    const people = [person(ME, 'Deepak Jayaram', true), person(NORA, 'Nora Bennett')];
    fake.update({ status: 'connected', people });
    expect(call.state.presence).toBe('away');
    fake.update({ people: [...people, person(REMY, 'Remy')], remy: 'listening' });
    await settle();
    expect(call.state.presence).toBe('here');
    expect(call.assistantLevel()).toBe(0.7);
    // While anyone talks, the face listens to the loudest of them.
    expect(call.yourLevel()).toBe(0.4);
    fake.update({ people, remy: null });
    await settle();
    expect(call.state.presence).toBe('away');
    stop();
  });

  it('speaks while she speaks and thinks while she thinks', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    const people = [person(ME, 'Deepak Jayaram', true), person(REMY, 'Remy')];
    const doing = (remy: RemyDoing) => fake.update({ status: 'connected', people, remy });
    doing('listening');
    await settle();
    doing('thinking');
    expect(call.state.activity).toBe('thinking');
    doing('speaking');
    expect(call.state.speaking).toBe(true);
    expect(call.state.activity).toBe('idle');
    doing('listening');
    expect(call.state.speaking).toBe(false);
    stop();
  });

  it('shows the call’s captions: her words, and each person’s by first name in their color, yours too', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    fake.update({ status: 'connected', people: [person(ME, 'Deepak Jayaram', true), person(NORA, 'Nora Bennett'), person(REMY, 'Remy')], remy: 'listening' });
    await settle();
    fake.caption(NORA, 'Remy, which days is the crane idle', false);
    expect(call.state.words).toMatchObject({ who: 'you', name: 'Nora', color: '#2563eb', text: 'Remy, which days is the crane idle', tentative: 2 });
    fake.caption(REMY, 'Monday to Wednesday.');
    expect(call.state.words).toMatchObject({ who: 'assistant', text: 'Monday to Wednesday.' });
    fake.caption(ME, 'Thanks.');
    expect(call.state.words).toMatchObject({ who: 'you', name: 'Deepak', color: '#695086', text: 'Thanks.', tentative: 0 });
    // Off the call, its words go with it.
    fake.update({ status: 'idle', people: [], remy: null });
    expect(call.state.words).toBeNull();
    stop();
  });

  it('runs a speaker’s lines together, as one caption, until someone else speaks', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    fake.update({ status: 'connected', people: [person(ME, 'Deepak Jayaram', true), person(NORA, 'Nora Bennett'), person(REMY, 'Remy')], remy: 'listening' });
    await settle();
    fake.caption(NORA, "Remy, can you add the tenant's new lights to the plan?", true, 1);
    fake.caption(NORA, 'All three', false, 2);
    expect(call.state.words).toMatchObject({ name: 'Nora', text: "Remy, can you add the tenant's new lights to the plan? All three", tentative: 2 });
    fake.caption(NORA, 'All three floors.', true, 2);
    expect(call.state.words).toMatchObject({ text: "Remy, can you add the tenant's new lights to the plan? All three floors.", tentative: 0 });
    fake.caption(REMY, 'Sure, one second.', true, 3);
    expect(call.state.words).toMatchObject({ who: 'assistant', text: 'Sure, one second.' });
    stop();
  });

  it('gives the caption to whoever starts talking at once, dots until their words are in', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    const people = (speaking: string | null) => [
      person(ME, 'Deepak Jayaram', true),
      { ...person(NORA, 'Nora Bennett'), speaking: speaking === NORA },
      person(REMY, 'Remy'),
    ];
    fake.update({ status: 'connected', people: people(null), remy: 'speaking' });
    await settle();
    fake.caption(REMY, 'Levels two and three look the', false, 1);
    expect(call.state.words).toMatchObject({ who: 'assistant' });
    // Nora cuts in: her name, no words yet; Remy's line, still coming in, doesn't take it back.
    fake.update({ people: people(NORA) });
    expect(call.state.words).toMatchObject({ who: 'you', name: 'Nora', color: '#2563eb', text: '' });
    fake.caption(REMY, 'Levels two and three look the same', false, 1);
    expect(call.state.words).toMatchObject({ name: 'Nora', text: '' });
    fake.caption(NORA, 'Yep, do all', false, 2);
    expect(call.state.words).toMatchObject({ name: 'Nora', text: 'Yep, do all' });
    stop();
  });

  it('leaves the caption alone when nobody is there to write the words down', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    fake.update({ status: 'connected', people: [person(ME, 'Deepak Jayaram', true), { ...person(NORA, 'Nora Bennett'), speaking: true }] });
    expect(call.state.words).toBeNull();
    stop();
  });

  it('hands on each finished line once: a person’s when final, Remy’s when her voice stops', async () => {
    vi.useFakeTimers();
    try {
      const call = new Call({ name: 'Remy', speed: 0 });
      const fake = fakeSession();
      const finals: FinalLine[] = [];
      const stop = followRemy(call, fake.session, { onFinal: (line) => finals.push(line) });
      const people = [person(ME, 'Deepak Jayaram', true), person(NORA, 'Nora Bennett'), person(REMY, 'Remy')];
      fake.update({ status: 'connected', people, remy: 'listening' });
      await vi.advanceTimersByTimeAsync(1000);
      fake.caption(NORA, 'Remy, which days', false, 1);
      fake.caption(NORA, 'Remy, which days is the crane idle?', true, 1);
      fake.caption(NORA, 'Remy, which days is the crane idle?', true, 1);
      expect(finals).toEqual([{ name: 'Nora', text: 'Remy, which days is the crane idle?' }]);
      fake.update({ remy: 'speaking' });
      fake.caption(REMY, 'Monday', false, 2);
      fake.caption(REMY, 'Monday to Wednesday.', false, 2);
      expect(finals).toHaveLength(1);
      fake.update({ remy: 'listening' });
      await vi.advanceTimersByTimeAsync(500);
      expect(finals.at(-1)).toEqual({ name: 'Remy', text: 'Monday to Wednesday.' });
      fake.caption(ME, 'Thanks.', true, 3);
      expect(finals.at(-1)).toEqual({ name: 'Deepak', text: 'Thanks.' });
      expect(finals).toHaveLength(3);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves words that aren’t the call’s own on screen', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    fake.update({ status: 'connected', people: [person(ME, 'Deepak Jayaram', true)] });
    fake.caption(ME, 'Hello?');
    // The walkthrough puts its own line up.
    await call.hear('I was out last week. What changed?', undefined, { reveal: false });
    fake.update({ status: 'idle', people: [] });
    expect(call.state.words?.text).toBe('I was out last week. What changed?');
    stop();
  });

  it('hands the face back as it was when the call ends', async () => {
    const call = new Call({ name: 'Remy', speed: 0 });
    const mine = { level: () => 0.2 };
    call.you = mine;
    const fake = fakeSession();
    const stop = followRemy(call, fake.session);
    fake.update({ status: 'connected', people: [person(ME, 'Deepak Jayaram', true), person(REMY, 'Remy')], remy: 'idle' });
    await settle();
    expect(call.you).not.toBe(mine);
    stop();
    expect(call.you).toBe(mine);
    expect(call.voice).toBeNull();
  });
});
