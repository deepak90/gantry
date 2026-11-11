/**
 * The how-to clips the assistant can show (`show_how`): short recordings of the real app made by
 * `pnpm clips` and listed in apps/web/public/clips/clips.json. The list is read from disk once, at
 * startup (no network); a card may only name a clip on it, and the stored card carries the clip's
 * own title and steps, never the model's retelling of them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClipManifest, matchClip, type HowToCard, type HowToClip } from '@collab/shared';
import { z } from 'zod';
import { REPO_ROOT } from '../env';

export const CLIP_MANIFEST = join(REPO_ROOT, 'apps', 'web', 'public', 'clips', 'clips.json');

/** The clips in a manifest file; none when it is missing or does not parse (with a warning). */
export function loadHowToClips(file = CLIP_MANIFEST): HowToClip[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = ClipManifest.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data.clips;
    console.warn(`[agent] ignoring ${file}: ${z.prettifyError(parsed.error)}`);
  } catch (error) {
    console.warn(`[agent] cannot read ${file}`, error);
  }
  return [];
}

let catalog: readonly HowToClip[] | null = null;

/** The clips as read at startup. */
export function howToClips(): readonly HowToClip[] {
  catalog ??= loadHowToClips();
  return catalog;
}

/** The clip list for the tool's description (byte-identical while the list is unchanged). */
export function describeClips(clips: readonly HowToClip[]): string {
  if (clips.length === 0) return ' No clips are recorded yet: explain the steps in words instead.';
  return ` The clips: ${clips.map((clip) => `${clip.id} (${clip.title})`).join('; ')}.`;
}

/** Problems with a card naming `query`; empty when it names a clip. */
export function checkHowTo(clips: readonly HowToClip[], query: string): string[] {
  if (matchClip(clips, query)) return [];
  if (clips.length === 0) return ['there are no how-to clips yet; explain the steps in words'];
  return [`no clip shows "${query}"; the clips are ${clips.map((clip) => `${clip.id} (${clip.title})`).join(', ')}. Use one of those ids, or explain the steps in words`];
}

/** The stored card for a clip: its id, title and steps as recorded. */
export function howToCard(clips: readonly HowToClip[], query: string): HowToCard | null {
  const clip = matchClip(clips, query);
  return clip ? { clip_id: clip.id, title: clip.title, steps: clip.steps } : null;
}
