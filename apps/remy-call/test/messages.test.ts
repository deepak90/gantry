import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, remyMessage, parseSayRequest, projectOfRoom, sayResponse, type RemyMessage } from '../src/messages.ts';

describe('data messages on topic remy', () => {
  const messages: RemyMessage[] = [
    { kind: 'heard', identity: 'a1b2', text: 'Remy, you on?', addressed: true, final: true, at: 1_794_081_241_139 },
    { kind: 'state', state: 'thinking' },
    { kind: 'said', id: 'reply-1', interrupted: false },
    { kind: 'filler', text: 'One sec.' },
  ];

  it.each(messages)('round-trips %o', (message) => {
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('is one flat JSON object with a kind', () => {
    const json = JSON.parse(new TextDecoder().decode(encodeMessage({ kind: 'said', id: 'x', interrupted: true })));
    expect(json).toEqual({ kind: 'said', id: 'x', interrupted: true });
  });

  it('refuses what is not in the contract', () => {
    const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
    expect(decodeMessage(bytes('not json'))).toBeNull();
    expect(decodeMessage(bytes({ kind: 'shout', text: 'hi' }))).toBeNull();
    expect(decodeMessage(bytes({ kind: 'state', state: 'sleeping' }))).toBeNull();
    expect(decodeMessage(bytes({ kind: 'heard', identity: 'a', text: 'x', addressed: true, final: false, at: 1 }))).toBeNull();
    expect(() => remyMessage.parse({ kind: 'said', id: '', interrupted: false })).toThrow();
  });
});

describe('remy.say', () => {
  it('reads a request, with or without who it answers', () => {
    expect(parseSayRequest(JSON.stringify({ id: 'r1', text: 'Done.' }))).toEqual({ ok: true, request: { id: 'r1', text: 'Done.' } });
    expect(parseSayRequest(JSON.stringify({ id: 'r1', text: 'Done.', to: 'session-7' }))).toEqual({ ok: true, request: { id: 'r1', text: 'Done.', to: 'session-7' } });
  });

  it('keeps the id of a bad request so it can be refused politely', () => {
    expect(parseSayRequest(JSON.stringify({ id: 'r2' }))).toMatchObject({ ok: false, id: 'r2' });
    expect(parseSayRequest(JSON.stringify({ text: 'hi' }))).toMatchObject({ ok: false, id: null });
    expect(parseSayRequest('{')).toMatchObject({ ok: false, id: null });
  });

  it('answers { id, accepted }', () => {
    expect(sayResponse.parse({ id: 'r1', accepted: true })).toEqual({ id: 'r1', accepted: true });
    expect(sayResponse.parse({ id: 'r1', accepted: false, reason: 'empty' })).toEqual({ id: 'r1', accepted: false, reason: 'empty' });
  });

  it('carries a proof that the service wrote the line, and refuses one that is malformed', () => {
    const proof = { turn: 'turn-1', whole: 'Done. Two days.', part: 'Two days.', sig: 'iI7_sc-3Brzn9Hf8zb_O7r252YOcWp8hljGAolOZph8' };
    expect(parseSayRequest(JSON.stringify({ id: 'r1', text: 'Two days.', proof }))).toEqual({ ok: true, request: { id: 'r1', text: 'Two days.', proof } });
    expect(parseSayRequest(JSON.stringify({ id: 'r1', text: 'x', proof: { ...proof, sig: 'short' } }))).toMatchObject({ ok: false, id: 'r1' });
    expect(parseSayRequest(JSON.stringify({ id: 'r1', text: 'x', proof: { ...proof, whole: 'w'.repeat(4001) } }))).toMatchObject({ ok: false, id: 'r1' });
    // The longest request, every character three bytes, still fits LiveKit's 15 KiB for an RPC payload.
    const longest = JSON.stringify({ id: crypto.randomUUID(), text: '’'.repeat(400), to: crypto.randomUUID(), proof: { ...proof, turn: 't'.repeat(64), whole: '’'.repeat(4000), part: '’'.repeat(400) } });
    expect(new TextEncoder().encode(longest).length).toBeLessThan(15 * 1024);
  });
});

describe('the call’s room', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000002';

  it('names its project, with or without the visit’s lease', () => {
    expect(projectOfRoom(`project-${PROJECT}`)).toBe(PROJECT);
    expect(projectOfRoom(`project-${PROJECT}-1794081000123`)).toBe(PROJECT);
    expect(projectOfRoom(`project-${PROJECT.toUpperCase()}-1`)).toBe(PROJECT);
  });

  it('is no project’s otherwise', () => {
    expect(projectOfRoom('smoke-room')).toBeNull();
    expect(projectOfRoom(`project-${PROJECT}-`)).toBeNull();
    expect(projectOfRoom(`project-${PROJECT}-12ab`)).toBeNull();
    expect(projectOfRoom(`xproject-${PROJECT}`)).toBeNull();
  });
});
