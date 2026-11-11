/**
 * Remy on a call: how she greets the people when she joins (a real greeting that ends with an offer to help, by the
 * names the event gives, worded fresh), how she opens an answer, and that the rules carry no names of their own for her
 * to repeat to people who have other names.
 */
import { describe, expect, it } from 'vitest';
import { callJoinedEvent, SYSTEM_PROMPT, systemPromptFor } from '../src/agent/prompts';

/** The rule under a heading of the system prompt, up to the next blank line. */
function section(heading: string): string {
  const start = SYSTEM_PROMPT.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = SYSTEM_PROMPT.indexOf('\n\n', start);
  return SYSTEM_PROMPT.slice(start, end < 0 ? undefined : end);
}

const quoted = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

describe('the greeting when Remy joins a call', () => {
  const rule = section('When an app event says you joined a call (call_joined)');

  it('greets warmly, briefly, and ends with an offer to help', () => {
    expect(rule).toMatch(/warm/);
    expect(rule).toMatch(/polite/);
    expect(rule).toMatch(/ending with an offer to help/);
    expect(rule).toMatch(/about 12 words/);
  });

  it('gives several shapes to word it from, not one line to repeat, each ending on the offer', () => {
    const shapes = quoted(rule).filter((line) => line.includes('?'));
    expect(shapes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(shapes.map((line) => line.split(/[.?]/).at(-2)?.trim())).size).toBe(shapes.length);
    for (const shape of shapes) expect(shape, shape).toMatch(/\?$/);
    expect(rule).toMatch(/fresh each call/);
    expect(rule).not.toMatch(/say you have the plan open/);
  });

  it('names only the people the event names, by first name, with a stand-in in the examples', () => {
    expect(rule).toMatch(/by first name, from the people the event names and only them/);
    expect(rule).toContain('{name}');
    expect(rule).toMatch(/three or more as everyone/);
  });

  it('says no time of day, and no news', () => {
    expect(rule).toMatch(/No time of day/);
    expect(rule).toMatch(/No news, figures or plan details/);
  });

  it('comes as an app event on the voice channel, naming the people on the call', () => {
    const at = '2026-11-10T20:00:00.000Z';
    expect(callJoinedEvent(['Ana Ruiz', 'Ben Ortiz'], at)).toBe(`<app_event type="call_joined" at="${at}" channel="voice">\nYou joined the call. On the call: Ana Ruiz, Ben Ortiz.\n</app_event>`);
    expect(callJoinedEvent([], at)).toBe(`<app_event type="call_joined" at="${at}" channel="voice">\nYou joined the call.\n</app_event>`);
  });
});

describe('how an answer opens', () => {
  const rule = section('How you speak');

  it('words its first few words fresh, not "Checking…" every time', () => {
    expect(rule).toMatch(/not "Checking…" every time/);
    expect(quoted(rule).filter((line) => /^(?:Pulling|Looking|Finding)/.test(line)).length).toBeGreaterThanOrEqual(3);
    expect(rule).not.toMatch(/"Checking the crane's dates\."/);
  });

  it('never opens with a filler of its own on a call, where the voice may have said one', () => {
    expect(rule).toMatch(/the voice may have said a short filler/);
    expect(rule).toMatch(/never open with one of your own/);
  });
});

describe('the rules carry no names of their own', () => {
  it.each([false, true])('names nobody from the film (hosted: %s)', (hosted) => {
    const prompt = systemPromptFor(hosted);
    for (const name of ['Deepak', 'Chris', 'Nora', 'Priya']) expect(prompt, name).not.toContain(name);
  });

  it('says who signs off and who sends an invoice by a stand-in for their first name', () => {
    expect(SYSTEM_PROMPT).toContain('so {name} signs off too');
    expect(SYSTEM_PROMPT).toContain("It's ready for {name}:");
  });
});
