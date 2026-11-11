/**
 * Renders the clip tapes that tests/clips recorded (test-results/tapes/<id>) into how-to clips:
 * <id>.webm (VP9, 1280x720, at the tape's frame rate) and <id>.png, the outcome it holds on before
 * it loops, in the output folder, and lists them in its clips.json (for the assistant's how-to card).
 *
 *   pnpm --filter @collab/clip-studio render [--id <clip>] [--out <dir>] [--no-captions] [--crf <0-63>]
 *
 * Remotion renders a near-lossless master next to the tape (master.mp4, H.264), which ffmpeg then
 * encodes to VP9 in two passes: camera moves over sharp text are what a clip spends its bytes on, and
 * the second pass puts them where they show. Renders with Playwright's headless Chrome (the one
 * tests/clips uses) when it is installed, else Remotion's own download, or `REMOTION_BROWSER`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClipManifest, ClipTape, HowToClip } from '../../packages/shared/src/clips.ts';
import { clipTiming } from './src/timing.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const TAPES = process.env.CLIP_TAPES_DIR ?? join(REPO, 'test-results/tapes');
const option = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const out = resolve(option('--out') ?? join(REPO, 'apps/web/public/clips'));
const captions = !process.argv.includes('--no-captions');
const only = option('--id');
/** VP9 quality (lower is sharper and larger): text has to stay clean while the camera moves. */
const crf = option('--crf') ?? '38';

function playwrightChrome(): string | null {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright'));
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const inner of readdirSync(join(cache, dir))) {
      const binary = join(cache, dir, inner, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}
const browser = process.env.REMOTION_BROWSER ?? playwrightChrome();

const ids = existsSync(TAPES) ? readdirSync(TAPES).filter((id) => existsSync(join(TAPES, id, 'tape.json')) && (!only || id === only)) : [];
if (ids.length === 0) {
  console.error(`No tapes${only ? ` for ${only}` : ''} in ${TAPES}: record them first (pnpm clips).`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });

for (const id of ids) {
  const tape = ClipTape.parse(JSON.parse(readFileSync(join(TAPES, id, 'tape.json'), 'utf8')));
  const props = JSON.stringify({ id, captions, tape: null });
  const common = ['exec', 'remotion'];
  const tail = [`--props=${props}`, `--public-dir=${TAPES}`, '--log=warn', ...(browser ? [`--browser-executable=${browser}`] : [])];
  const timing = clipTiming(tape);
  const master = join(TAPES, id, 'master.mp4');
  // Lossless frames into the encoder (Remotion's default JPEG frames blur text edges) and BT.709, the
  // colors browsers assume for HD video.
  const frames = ['--image-format=png', '--pixel-format=yuv420p', '--color-space=bt709'];
  execFileSync('pnpm', [...common, 'render', 'src/index.ts', 'HowTo', master, '--codec=h264', '--crf=6', ...frames, ...tail], { cwd: HERE, stdio: 'inherit' });
  // One keyframe for the whole clip (a screen barely changes from frame to frame; libvpx would start
  // afresh every 12 frames), alt-ref frames to carry the still parts, tagged BT.709 like the master.
  const passLog = join(TAPES, id, 'vp9');
  const vp9 = ['-y', '-v', 'error', '-i', master, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', crf, '-g', String(timing.frames), '-row-mt', '1', '-deadline', 'good', '-pix_fmt', 'yuv420p', '-an', '-passlogfile', passLog];
  const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  execFileSync('pnpm', [...common, 'ffmpeg', ...vp9, '-pass', '1', '-cpu-used', '4', '-f', 'null', '-'], { cwd: HERE, stdio: 'inherit' });
  execFileSync('pnpm', [...common, 'ffmpeg', ...vp9, '-pass', '2', '-cpu-used', '1', '-auto-alt-ref', '1', '-lag-in-frames', '25', ...tags, join(out, `${id}.webm`)], { cwd: HERE, stdio: 'inherit' });
  // The poster: the outcome the clip holds on before it loops.
  execFileSync('pnpm', [...common, 'still', 'src/index.ts', 'HowTo', join(out, `${id}.png`), `--frame=${timing.poster}`, ...tail], { cwd: HERE, stdio: 'inherit' });
  const clip = HowToClip.parse({ id, ...tape.meta, duration_ms: Math.round((timing.frames / tape.fps) * 1000), bytes: statSync(join(out, `${id}.webm`)).size, recorded_at: new Date().toISOString() });
  const manifestFile = join(out, 'clips.json');
  const { clips } = existsSync(manifestFile) ? ClipManifest.parse(JSON.parse(readFileSync(manifestFile, 'utf8'))) : { clips: [] };
  const index = clips.findIndex((existing) => existing.id === id);
  const listed = index === -1 ? [...clips, clip] : clips.map((existing, at) => (at === index ? clip : existing));
  writeFileSync(manifestFile, `${JSON.stringify(ClipManifest.parse({ clips: listed }), null, 2)}\n`);
  console.log(`${id}: ${join(out, `${id}.webm`)} (${Math.round(clip.bytes / 1024)} KB, ${(clip.duration_ms / 1000).toFixed(1)} s)`);
}
