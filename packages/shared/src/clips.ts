/**
 * The instructional clips: short screen recordings of the real app (tests/clips, `pnpm clips`),
 * served by the web app from `apps/web/public/clips/` as `<id>.webm` with a `<id>.png` poster (the
 * last frame). `clips.json` there lists them; the assistant reads it at startup to offer a clip when
 * someone asks how to do something (its `show_how` card), and the card plays the clip in the thread.
 */
import { z } from 'zod';

/** A clip id: lower-case words joined by hyphens, e.g. "link-tasks" (also its file name). */
export const CLIP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ClipId = z.string().max(40).regex(CLIP_ID_PATTERN, 'lower-case words joined by hyphens, e.g. "link-tasks"');

export const HowToClip = z.object({
  id: ClipId,
  /** What it teaches, as a task: "Link two tasks". */
  title: z.string().min(1).max(60),
  /** One line on what the clip shows. */
  summary: z.string().min(1).max(160),
  /** The steps as short plain sentences, shown under the clip. */
  steps: z.array(z.string().min(1).max(120)).min(1).max(6),
  /** Words people use for it ("dependency", "connect"), for finding the clip from a question. */
  topics: z.array(z.string().min(1).max(40)).max(12).default([]),
  duration_ms: z.int().positive(),
  /** Size of the WebM file. */
  bytes: z.int().positive(),
  recorded_at: z.iso.datetime({ offset: true }),
});
export type HowToClip = z.infer<typeof HowToClip>;

export const ClipManifest = z.object({
  clips: z.array(HowToClip).max(50),
});
export type ClipManifest = z.infer<typeof ClipManifest>;

/** A rectangle in the recorded window's CSS pixels. */
export const ClipRect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
export type ClipRect = z.infer<typeof ClipRect>;

/**
 * A recording before it becomes a clip (tests/clips records it, apps/clip-studio cuts it): the whole
 * window, frame by frame, where the pointer went and when it pressed, where the camera should look,
 * and when each step starts. Times are milliseconds from the start of the recording.
 */
export const ClipTape = z.object({
  id: ClipId,
  /** What the clip teaches: its entry in clips.json, which the clip studio writes once the clip is cut. */
  meta: HowToClip.pick({ title: true, summary: true, steps: true, topics: true }),
  /** Frames a second: the page's clock moved 1/fps s between frames (the clip is cut at this rate). */
  fps: z.int().positive(),
  /** The window in CSS pixels; `scale` device pixels per CSS pixel in the frames. */
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }),
  duration_ms: z.number().positive(),
  /** Full-window JPEGs, one a frame, file names relative to the tape's folder (frames that look the same share a file). */
  frames: z.array(z.object({ file: z.string(), t: z.number() })).min(1),
  pointer: z.array(z.object({ t: z.number(), x: z.number(), y: z.number(), down: z.boolean() })),
  /**
   * Where to look from `t` on: `rect` is what must be in the shot (the camera widens it to the clip's
   * shape and keeps it in the window), reached over `ms`; `ring` marks the thing itself, or null.
   */
  looks: z.array(z.object({ t: z.number(), rect: ClipRect, ms: z.number().nonnegative(), ring: ClipRect.nullable() })),
  /** The clip's steps as they happen (a caption each). */
  steps: z.array(z.object({ t: z.number(), text: z.string() })),
});
export type ClipTape = z.infer<typeof ClipTape>;

/** Where the web app serves a clip's files, relative to its base URL. */
export function clipFiles(id: string): { video: string; poster: string } {
  if (!CLIP_ID_PATTERN.test(id)) throw new Error(`Not a clip id: ${id}`);
  return { video: `clips/${id}.webm`, poster: `clips/${id}.png` };
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'i', 'we', 'you', 'do', 'does', 'how', 'can', 'to', 'in', 'on', 'of', 'it', 'my', 'me', 'one', 'into', 'from', 'with', 'and', 'or', 'show', 'please', 'is', 'there', 'way', 'what']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
}

/**
 * The clip a question or id names: the clip with that id, else the one whose title, topics and summary
 * share the most words with it (topics and title count double). Null when nothing shares a word.
 */
export function matchClip(clips: readonly HowToClip[], query: string): HowToClip | null {
  const wanted = query.trim().toLowerCase();
  const exact = clips.find((clip) => clip.id === wanted);
  if (exact) return exact;
  const asked = new Set(words(wanted));
  if (asked.size === 0) return null;
  let best: { clip: HowToClip; score: number } | null = null;
  for (const clip of clips) {
    const strong = new Set(words([clip.id, clip.title, ...clip.topics].join(' ')));
    const weak = new Set(words(clip.summary));
    let score = 0;
    for (const word of asked) score += strong.has(word) ? 2 : weak.has(word) ? 1 : 0;
    if (score > 0 && (!best || score > best.score)) best = { clip, score };
  }
  return best?.clip ?? null;
}
