import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClipManifest, clipFiles, matchClip, type HowToClip } from '../src/clips';

const manifest = fileURLToPath(new URL('../../../apps/web/public/clips/clips.json', import.meta.url));

describe('the clip manifest', () => {
  it('apps/web/public/clips/clips.json fits the schema, with unique ids and a file pair for each', () => {
    const { clips } = ClipManifest.parse(JSON.parse(readFileSync(manifest, 'utf8')));
    expect(clips.length).toBeGreaterThan(0);
    expect(new Set(clips.map((clip) => clip.id)).size).toBe(clips.length);
    for (const clip of clips) expect(clipFiles(clip.id)).toEqual({ video: `clips/${clip.id}.webm`, poster: `clips/${clip.id}.png` });
  });

  it('refuses ids that are not file-safe', () => {
    expect(() => clipFiles('../secrets')).toThrow(/Not a clip id/);
    expect(ClipManifest.safeParse({ clips: [{ id: 'Link Tasks' }] }).success).toBe(false);
  });

  it('matches an id, or the words of a question, preferring titles and topics over summaries', () => {
    const clip = (id: string, title: string, topics: string[], summary: string): HowToClip => ({ id, title, summary, topics, steps: ['A step.'], duration_ms: 1, bytes: 1, recorded_at: '2026-10-25T00:00:00Z' });
    const clips = [clip('link-tasks', 'Link two tasks', ['dependency'], 'Drag from one bar to another.'), clip('watch-recipe', 'Watch the plan with a rule', ['alert'], 'Pick a recipe; it links to nothing.')];
    expect(matchClip(clips, 'watch-recipe')?.id).toBe('watch-recipe');
    expect(matchClip(clips, 'Linking tasks?')?.id).toBe('link-tasks');
    expect(matchClip(clips, 'add a dependency')?.id).toBe('link-tasks');
    expect(matchClip(clips, 'set up alerts')?.id).toBe('watch-recipe');
    expect(matchClip(clips, 'the')).toBeNull();
  });
});
