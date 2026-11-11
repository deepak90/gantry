/**
 * The call's wire: what the dev server's token route accepts, the attributes everyone reads, Remy's
 * messages as they arrive, her answer to `remy.say`, which heard lines a tab posts to the thread, and
 * how a walkthrough's wait matches a line.
 */
import { describe, expect, it } from 'vitest';
import { attributesOf, heardMatches, REMY, messageOf, postsHeard, roomFor, roomOf, sayPayload, sayReplyOf, tokenRequestOf, type Heard } from '../../src/call/protocol';

const PROJECT = '00000000-0000-4000-8000-000000000002';
const SESSION = '6f1c2a40-1b2c-4d3e-8f90-123456789abc';

const request = (overrides: Record<string, unknown> = {}) => ({ projectId: PROJECT, sessionId: SESSION, name: 'Nora Bennett', color: '#2563eb', role: 'cm', ...overrides });

const heard = (overrides: Partial<Heard> = {}): Heard => ({ identity: SESSION, text: 'Remy, what is the crane doing?', addressed: true, final: true, at: 1_762_000_000_000, ...overrides });

describe('the token request', () => {
  it('takes a project, a session, a name, a cursor color and a role', () => {
    expect(tokenRequestOf(request())).toEqual({ ok: true, value: { projectId: PROJECT, sessionId: SESSION, name: 'Nora Bennett', color: '#2563eb', role: 'cm', sim: false, remy: true } });
  });

  it('brings Remy unless the join asks to leave her out', () => {
    expect(tokenRequestOf(request({ remy: false }))).toMatchObject({ ok: true, value: { remy: false } });
    expect(tokenRequestOf(request({ remy: true }))).toMatchObject({ ok: true, value: { remy: true } });
    expect(tokenRequestOf(request({ remy: 'later' }))).toEqual({ ok: false, error: 'remy is true or false' });
  });

  it('takes a simulated person with their role on site', () => {
    const checked = tokenRequestOf(request({ name: 'Tom Becker (sim)', role: 'MEP coordinator', sim: true }));
    expect(checked).toMatchObject({ ok: true, value: { role: 'MEP coordinator', sim: true } });
    expect(tokenRequestOf(request({ role: 'Architect’s site rep' })).ok).toBe(true);
    expect(tokenRequestOf(request({ role: "Architect's site rep" })).ok).toBe(true);
  });

  it('writes ids and colors one way, and trims the name', () => {
    const checked = tokenRequestOf(request({ projectId: PROJECT.toUpperCase(), sessionId: SESSION.toUpperCase(), color: '#2563EB', name: '  Nora Bennett ' }));
    expect(checked).toMatchObject({ ok: true, value: { projectId: PROJECT, sessionId: SESSION, color: '#2563eb', name: 'Nora Bennett' } });
  });

  it('refuses anything else, saying what is wrong', () => {
    expect(tokenRequestOf(null)).toEqual({ ok: false, error: 'Not a request' });
    expect(tokenRequestOf([request()])).toEqual({ ok: false, error: 'Not a request' });
    expect(tokenRequestOf(request({ projectId: 'project-2' }))).toEqual({ ok: false, error: 'Unknown project' });
    // The identity on the call is the tab's session: nobody gets to be "remy".
    expect(tokenRequestOf(request({ sessionId: REMY }))).toEqual({ ok: false, error: 'Unknown session' });
    expect(tokenRequestOf(request({ name: '' }))).toEqual({ ok: false, error: 'A name is 1 to 80 characters' });
    expect(tokenRequestOf(request({ name: 'x'.repeat(81) }))).toEqual({ ok: false, error: 'A name is 1 to 80 characters' });
    expect(tokenRequestOf(request({ color: 'red' }))).toEqual({ ok: false, error: 'A color is #rrggbb' });
    expect(tokenRequestOf(request({ color: '#25e' }))).toEqual({ ok: false, error: 'A color is #rrggbb' });
    expect(tokenRequestOf(request({ role: '' }))).toEqual({ ok: false, error: 'Unknown role' });
    expect(tokenRequestOf(request({ role: 'admin; drop' }))).toEqual({ ok: false, error: 'Unknown role' });
    expect(tokenRequestOf(request({ sim: 'yes' }))).toEqual({ ok: false, error: 'sim is true or false' });
  });

  it('puts name, color and role on the person, and sim only on a simulated one', () => {
    const nora = tokenRequestOf(request());
    const tom = tokenRequestOf(request({ name: 'Tom Becker (sim)', role: 'MEP coordinator', sim: true }));
    if (!nora.ok || !tom.ok) throw new Error('both are requests');
    expect(attributesOf(nora.value)).toEqual({ name: 'Nora Bennett', color: '#2563eb', role: 'cm' });
    expect(attributesOf(tom.value)).toEqual({ name: 'Tom Becker (sim)', color: '#2563eb', role: 'MEP coordinator', sim: 'true' });
  });

  it('names one room per project on this machine, and one per visit of a copy on the hosted site', () => {
    expect(roomFor(PROJECT)).toBe(`project-${PROJECT}`);
    expect(roomFor(PROJECT, null)).toBe(`project-${PROJECT}`);
    expect(roomFor(PROJECT, 1_794_391_200_123)).toBe(`project-${PROJECT}-1794391200123`);
    // The next visitor of the same copy is on a call of their own.
    expect(roomFor(PROJECT, 1_794_391_800_000)).not.toBe(roomFor(PROJECT, 1_794_391_200_123));
  });

  it('reads the project and the visit back from a room’s name, and nothing from any other room', () => {
    expect(roomOf(roomFor(PROJECT))).toEqual({ projectId: PROJECT, lease: null });
    expect(roomOf(roomFor(PROJECT, 1_794_391_200_123))).toEqual({ projectId: PROJECT, lease: 1_794_391_200_123 });
    expect(roomOf(`project-${PROJECT.toUpperCase()}-7`)).toEqual({ projectId: PROJECT, lease: 7 });
    expect(roomOf('smoke-room')).toBeNull();
    expect(roomOf(`project-${PROJECT}-`)).toBeNull();
    expect(roomOf(`project-${PROJECT}-1x`)).toBeNull();
  });
});

describe('Remy’s messages', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it('reads a heard line, its fields beside the kind', () => {
    expect(messageOf(encode({ kind: 'heard', identity: SESSION, text: 'Remy, book it.', addressed: true, final: true, at: 1_762_000_000_123 }))).toEqual({
      kind: 'heard',
      identity: SESSION,
      text: 'Remy, book it.',
      addressed: true,
      final: true,
      at: 1_762_000_000_123,
    });
  });

  it('takes only final lines with who said them, whether it was to Remy, and when', () => {
    expect(messageOf(JSON.stringify({ kind: 'heard', identity: SESSION, text: 'Hi', addressed: true, final: false, at: 1 }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'heard', text: 'Hi', addressed: true, final: true, at: 1 }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'heard', identity: SESSION, text: 'Hi', final: true, at: 1 }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'heard', identity: SESSION, text: 'Hi', addressed: true, final: true }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'heard', identity: SESSION, text: 'Hi', addressed: true, final: true, at: '2026-11-07T20:00:00Z' }))).toBeNull();
  });

  it('reads only the flat form Remy sends', () => {
    expect(messageOf(JSON.stringify({ kind: 'said', body: { id: 'line-1', interrupted: false } }))).toBeNull();
  });

  it('reads her state, a line played, and a filler', () => {
    expect(messageOf(JSON.stringify({ kind: 'state', state: 'thinking' }))).toEqual({ kind: 'state', state: 'thinking' });
    expect(messageOf(JSON.stringify({ kind: 'state', state: 'dancing' }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'said', id: 'line-1', interrupted: true }))).toEqual({ kind: 'said', id: 'line-1', interrupted: true });
    expect(messageOf(JSON.stringify({ kind: 'said', id: 'line-2' }))).toEqual({ kind: 'said', id: 'line-2', interrupted: false });
    expect(messageOf(JSON.stringify({ kind: 'said' }))).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'filler', text: 'One sec.' }))).toEqual({ kind: 'filler', text: 'One sec.' });
  });

  it('drops what isn’t one of her messages', () => {
    expect(messageOf('not json')).toBeNull();
    expect(messageOf('[1,2]')).toBeNull();
    expect(messageOf(JSON.stringify({ kind: 'cursor', x: 1 }))).toBeNull();
    expect(messageOf(JSON.stringify({ type: 'said', id: 'x' }))).toBeNull();
  });

  it('hands her a line, and reads whether she took it', () => {
    expect(JSON.parse(sayPayload('line-1', 'It’s booked.'))).toEqual({ id: 'line-1', text: 'It’s booked.' });
    expect(sayReplyOf(JSON.stringify({ id: 'line-1', accepted: true }))).toEqual({ id: 'line-1', accepted: true });
    expect(sayReplyOf(JSON.stringify({ id: 'line-1' }))).toBeNull();
    expect(sayReplyOf('oops')).toBeNull();
  });
});

describe('which heard lines this tab posts', () => {
  it('posts its own person’s line said to Remy, as Remy heard it', () => {
    expect(postsHeard(heard(), { from: REMY, me: SESSION })).toBe(true);
  });

  it('leaves everyone else’s lines to their own tabs', () => {
    expect(postsHeard(heard({ identity: 'someone-else' }), { from: REMY, me: SESSION })).toBe(false);
  });

  it('keeps out of people talking to each other', () => {
    expect(postsHeard(heard({ addressed: false }), { from: REMY, me: SESSION })).toBe(false);
  });

  it('believes only Remy: anyone on the call can send on her topic', () => {
    expect(postsHeard(heard(), { from: 'nora-tab', me: SESSION })).toBe(false);
    expect(postsHeard(heard(), { from: null, me: SESSION })).toBe(false);
  });

  it('posts nothing empty, and nothing before the tab knows who it is', () => {
    expect(postsHeard(heard({ text: '   ' }), { from: REMY, me: SESSION })).toBe(false);
    expect(postsHeard(heard(), { from: REMY, me: '' })).toBe(false);
  });
});

describe('waiting for a line', () => {
  const line = heard({ text: 'So, um— Remy, can we book the crane only for the days it works?' });

  it('matches words in order, whatever the case and punctuation', () => {
    expect(heardMatches(line, SESSION, 'book the crane')).toBe(true);
    expect(heardMatches(line, SESSION, 'BOOK THE CRANE!')).toBe(true);
    expect(heardMatches(line, SESSION, 'crane the book')).toBe(false);
    // Whole words: "cran" is not "crane".
    expect(heardMatches(line, SESSION, 'cran')).toBe(false);
    expect(heardMatches(line, SESSION, '')).toBe(true);
  });

  it('matches only the person waited for, or anyone', () => {
    expect(heardMatches(line, 'someone-else', 'crane')).toBe(false);
    expect(heardMatches(line, null, 'crane')).toBe(true);
  });

  it('takes a pattern, read from the start every time, or a test', () => {
    const pattern = /crane/gi;
    expect(heardMatches(line, null, pattern)).toBe(true);
    expect(heardMatches(line, null, pattern)).toBe(true);
    expect(heardMatches(line, null, (candidate) => candidate.addressed)).toBe(true);
    expect(heardMatches(heard({ addressed: false }), null, (candidate) => candidate.addressed)).toBe(false);
  });
});
