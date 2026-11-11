/**
 * The how-to clips: the manifest is read from disk and checked; a question or an id finds its clip; a
 * card that names no clip is refused with the list of clips; and through the whole service (scripted
 * model), "how do I …" comes back as a how-to card carrying the clip's own title and steps.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipManifest, HowToCard, matchClip, parseCardProps, type HowToClip } from '@collab/shared';
import { TOOL_DEFINITIONS } from '../src/agent/brain';
import { groundCard } from '../src/agent/grounding';
import { CLIP_MANIFEST, checkHowTo, describeClips, howToCard, loadHowToClips } from '../src/agent/how-to';
import { FakeBrowser, FakeDb, FakeTransport, presenceOf } from '../src/dev/fake';
import { makeClient } from '../src/llm/client';
import { silentLogger } from '../src/log';
import { ProjectAgent } from '../src/project-agent';
import type { TurnResult } from '../src/agent/brain';

const clip = (id: string, title: string, topics: string[], summary = `${title}.`): HowToClip => ({
  id,
  title,
  summary,
  steps: [`First step of ${title.toLowerCase()}.`, 'Then the next one.'],
  topics,
  duration_ms: 7_000,
  bytes: 80_000,
  recorded_at: '2026-10-25T05:36:00.000Z',
});

const CLIPS: HowToClip[] = [
  clip('link-tasks', 'Link two tasks', ['link', 'dependency', 'connect tasks', 'arrow']),
  clip('library-drop', 'Add work from the library', ['library', 'snippet', 'drag', 'drop', 'template']),
  clip('save-to-library', 'Save work to the library', ['save to library', 'library', 'snippet', 'reuse']),
  clip('watch-recipe', 'Watch the plan with a rule', ['watch', 'rule', 'alert', 'recipe']),
];

const base = { issues: new Map(), checks: new Map(), knownMinor: new Set<number>(), clips: CLIPS };

describe('the clip list', () => {
  it('reads the recorded manifest (apps/web/public/clips/clips.json) and every entry fits the shared schema', () => {
    const clips = loadHowToClips(CLIP_MANIFEST);
    expect(clips.length).toBeGreaterThan(0);
    expect(ClipManifest.safeParse({ clips }).success).toBe(true);
    for (const entry of clips) expect(entry.id).toMatch(/^[a-z0-9-]+$/);
  });

  it('reads nothing from a missing or malformed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clips-'));
    expect(loadHowToClips(join(dir, 'missing.json'))).toEqual([]);
    const bad = join(dir, 'clips.json');
    writeFileSync(bad, JSON.stringify({ clips: [{ id: 'Not An Id' }] }));
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(loadHowToClips(bad)).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });

  it('finds a clip by id, or by what someone wants to do', () => {
    expect(matchClip(CLIPS, 'link-tasks')?.id).toBe('link-tasks');
    expect(matchClip(CLIPS, 'link two tasks')?.id).toBe('link-tasks');
    expect(matchClip(CLIPS, 'add a dependency between the dig and the inspection')?.id).toBe('link-tasks');
    expect(matchClip(CLIPS, 'save these tasks to the library')?.id).toBe('save-to-library');
    expect(matchClip(CLIPS, 'drag a snippet into the plan')?.id).toBe('library-drop');
    expect(matchClip(CLIPS, 'set up an alert rule')?.id).toBe('watch-recipe');
    expect(matchClip(CLIPS, 'pay the supplier with PayPal')).toBeNull();
    expect(matchClip(CLIPS, 'how do I')).toBeNull();
  });

  it('lists the clips in the show_how tool description for the model', () => {
    expect(describeClips(CLIPS)).toBe(' The clips: link-tasks (Link two tasks); library-drop (Add work from the library); save-to-library (Save work to the library); watch-recipe (Watch the plan with a rule).');
    expect(describeClips([])).toMatch(/No clips/);
    const tool = TOOL_DEFINITIONS.find((definition) => definition.name === 'show_how')!;
    expect(tool.description).toMatch(/how to do something in this app/);
    expect(tool.input_schema).toMatchObject({ required: ['clip'] });
  });
});

describe('the how-to card', () => {
  it('is shown only for a clip that exists, and the stored card carries its own title and steps', () => {
    expect(groundCard('show_how', { clip: 'link two tasks' }, base)).toEqual([]);
    expect(groundCard('show_how', { clip: 'pay the supplier' }, base)).toEqual([expect.stringMatching(/no clip shows "pay the supplier"; the clips are link-tasks \(Link two tasks\)/)]);
    expect(checkHowTo([], 'link-tasks')).toEqual([expect.stringMatching(/no how-to clips yet/)]);
    const card = howToCard(CLIPS, 'link two tasks');
    expect(card).toEqual({ clip_id: 'link-tasks', title: 'Link two tasks', steps: CLIPS[0]!.steps });
    expect(HowToCard.safeParse(card).success).toBe(true);
    expect(parseCardProps('show_how', card)).toEqual(card);
    // A stored card must name a clip by its file-safe id.
    expect(parseCardProps('show_how', { ...card, clip_id: '../secrets' })).toBeNull();
  });
});

describe('"how do I …" through the service (scripted model)', () => {
  function setup() {
    const db = new FakeDb();
    const transport = new FakeTransport();
    const browser = new FakeBrowser(db, transport, { commandDelayMs: 5 });
    const turns: TurnResult[] = [];
    const agent = new ProjectAgent({
      projectId: db.projectId,
      store: db,
      transport,
      client: makeClient('mock', { delayMs: 0 }),
      models: { analysis: 'claude-opus-5-5', chat: 'claude-sonnet-5-5' },
      log: silentLogger,
      debounce: { presence: 0, workflow: 5, plan: 5 },
      openingDelayMs: 0,
      raiseIssues: false,
      clips: CLIPS,
      onTurn: (result) => turns.push(result),
    });
    return { db, transport, browser, agent, turns };
  }

  it('answers with the clip for the question, stored for every browser', async () => {
    const { db, transport, browser, agent, turns } = setup();
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm'));
    await agent.idle();
    browser.say('pm', 'How do I link two tasks?');
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.toolCalls.map((call) => call.name)).toEqual(['reply', 'show_how']);
    expect(turn.cards).toEqual([{ id: expect.any(String), component: 'show_how', props: { clip_id: 'link-tasks', title: 'Link two tasks', steps: CLIPS[0]!.steps } }]);
    const stored = db.messages.at(-1)!;
    expect(stored.role).toBe('assistant');
    expect(stored.cards[0]?.props).toEqual({ clip_id: 'link-tasks', title: 'Link two tasks', steps: CLIPS[0]!.steps });
    await agent.stop();
  });

  it('says so in words when no clip shows it', async () => {
    const { db, transport, browser, agent, turns } = setup();
    await agent.start();
    transport.presence(db.projectId, presenceOf('pm'));
    await agent.idle();
    browser.say('pm', 'Show me how to pay the supplier with PayPal');
    await agent.idle();
    const turn = turns.at(-1)!;
    expect(turn.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ['reply', true],
      ['show_how', false],
      ['reply', true],
    ]);
    expect(turn.cards).toEqual([]);
    expect(db.messages.at(-1)!.text).toMatch(/don't have a clip for that one yet/);
    await agent.stop();
  });
});
