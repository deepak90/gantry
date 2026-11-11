/**
 * A how-to clip cut from a tape: the recorded window through a moving camera (director.ts), a
 * cursor drawn smoothly over it with a ripple on every press, a ring and a soft spotlight on what a
 * look points at, and the step being shown as a caption. While the button is down the cursor follows
 * the frame's own moment, so it stays on whatever it drags; otherwise it moves at the clip's rate.
 * The clip runs at the tape's frame rate, holds on the outcome, and dissolves back to its opening
 * shot (timing.ts) so it loops without a jump.
 */
import { loadFont } from '@remotion/google-fonts/Archivo';
import { useMemo } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, type CalculateMetadataFunction } from 'remotion';
import type { ClipRect, ClipTape } from '../../../packages/shared/src/clips';
import { direct, type Director, type Shot } from './director';
import { HOLD_MS, LOOP_MS, clipTiming } from './timing';

const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'], subsets: ['latin'] });

/** Until the tape is read (it sets the clip's own rate). */
export const FPS = 60;
const ACCENT = '#2f5bd3';
/** The bottom of the clip the caption takes: the camera keeps what it shows above it. */
const CAPTION_INSET = 0.13;
const INK = '#11151c';

export type HowToProps = { id: string; captions: boolean; tape: ClipTape | null };

export const calculateHowTo: CalculateMetadataFunction<HowToProps> = async ({ props, abortSignal }) => {
  const response = await fetch(staticFile(`${props.id}/tape.json`), { signal: abortSignal });
  if (!response.ok) throw new Error(`No tape for ${props.id}: record it first (pnpm clips)`);
  const tape = (await response.json()) as ClipTape;
  return { fps: tape.fps, durationInFrames: clipTiming(tape).frames, props: { ...props, tape } };
};

const clamp01 = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Window pixels to clip pixels. */
const toClip = (shot: Shot, scale: number, x: number, y: number) => ({ x: (x - shot.x) * scale, y: (y - shot.y) * scale });

function Spotlight({ rect, shot, scale, t, look, unit }: { rect: ClipRect; shot: Shot; scale: number; t: number; look: NonNullable<ReturnType<Director['lookAt']>>; unit: number }) {
  const { width: frameWidth, height: frameHeight } = useVideoConfig();
  // In once the camera has nearly arrived, out as the next look begins.
  const shown = interpolate(t, [look.t + look.ms * 0.55, look.t + look.ms * 0.55 + 260], [0, 1], { ...clamp01, easing: Easing.out(Easing.cubic) }) * interpolate(t, [look.next - 40, look.next + 200], [1, 0], clamp01);
  if (shown <= 0) return null;
  const at = toClip(shot, scale, rect.x, rect.y);
  const grow = interpolate(shown, [0, 1], [10, 0]) * unit;
  // The ring stays whole inside the frame, even around something at the window's edge.
  const margin = 5 * unit;
  const left = Math.max(margin, at.x - 6 * unit - grow);
  const top = Math.max(margin, at.y - 6 * unit - grow);
  const right = Math.min(frameWidth - margin, at.x + rect.width * scale + 6 * unit + grow);
  const bottom = Math.min(frameHeight - margin, at.y + rect.height * scale + 6 * unit + grow);
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: right - left,
        height: bottom - top,
        borderRadius: 12 * unit,
        opacity: shown,
        boxShadow: `0 0 0 ${3 * unit}px ${ACCENT}, 0 0 ${28 * unit}px ${6 * unit}px rgb(47 91 211 / 0.35), 0 0 0 ${4000 * unit}px rgb(17 21 28 / ${0.22 * shown})`,
        pointerEvents: 'none',
      }}
    />
  );
}

function Cursor({ x, y, pressed, unit }: { x: number; y: number; pressed: number; unit: number }) {
  const size = 30 * unit * (1 - 0.14 * pressed);
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" style={{ position: 'absolute', left: x - (3 / 22) * size, top: y - (2 / 22) * size, filter: `drop-shadow(0 ${2 * unit}px ${3 * unit}px rgb(0 0 0 / 0.4))`, overflow: 'visible' }}>
      <path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z" fill={INK} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}

function Ripple({ x, y, age, unit }: { x: number; y: number; age: number; unit: number }) {
  const progress = interpolate(age, [0, 520], [0, 1], { ...clamp01, easing: Easing.out(Easing.cubic) });
  const radius = interpolate(progress, [0, 1], [8, 38]) * unit;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - radius,
        top: y - radius,
        width: radius * 2,
        height: radius * 2,
        borderRadius: '50%',
        border: `${3 * unit}px solid ${ACCENT}`,
        background: `rgb(47 91 211 / ${0.18 * (1 - progress)})`,
        opacity: 1 - progress,
      }}
    />
  );
}

/** A step's caption: it rises in `age` ms after its step starts, and sinks away once `leaving` ms into the next. */
function Caption({ number, text, age, leaving, unit }: { number: number; text: string; age: number; leaving?: number; unit: number }) {
  const shown = interpolate(age, [0, 380], [0, 1], { ...clamp01, easing: Easing.bezier(0.16, 1, 0.3, 1) }) * (leaving === undefined ? 1 : interpolate(leaving, [0, 170], [1, 0], { ...clamp01, easing: Easing.in(Easing.quad) }));
  if (shown <= 0) return null;
  const rise = leaving === undefined ? (1 - shown) * 18 : -(1 - shown) * 8;
  return (
    <div
      style={{
        position: 'absolute',
        left: 28 * unit,
        bottom: 26 * unit,
        maxWidth: '86%',
        display: 'flex',
        alignItems: 'center',
        gap: 14 * unit,
        padding: `${12 * unit}px ${22 * unit}px ${12 * unit}px ${12 * unit}px`,
        borderRadius: 999,
        background: 'rgb(17 21 28 / 0.88)',
        boxShadow: `0 ${8 * unit}px ${30 * unit}px rgb(0 0 0 / 0.28)`,
        color: '#f4f6fb',
        fontFamily,
        fontSize: 24 * unit,
        fontWeight: 600,
        lineHeight: 1.25,
        opacity: shown,
        transform: `translateY(${rise * unit}px)`,
      }}
    >
      <span
        style={{
          flex: 'none',
          display: 'grid',
          placeItems: 'center',
          width: 36 * unit,
          height: 36 * unit,
          borderRadius: '50%',
          background: ACCENT,
          fontSize: 20 * unit,
          fontWeight: 700,
          transform: `scale(${leaving === undefined ? interpolate(age, [0, 260, 420], [0.6, 1.12, 1], clamp01) : 1})`,
        }}
      >
        {number}
      </span>
      <span>{text}</span>
    </div>
  );
}

/** The next caption waits this long for the last one to sink away. */
const CAPTION_GAP_MS = 120;

/** The tape at `t`: the frame through the camera, the ring, the presses, the cursor and the caption. */
function Scene({ id, tape, director, captions, t, unit }: { id: string; tape: ClipTape; director: Director; captions: boolean; t: number; unit: number }) {
  const { width } = useVideoConfig();
  const shot = director.shotAt(t);
  const scale = width / shot.width;
  const image = director.frameAt(t);
  const point = director.pointerAt(t);
  // Dragging: the cursor keeps to the frame on screen, so it stays on what it carries.
  const held = point.down ? director.pointerAt(image.t) : point;
  const cursor = toClip(shot, scale, held.x, held.y);
  const pressed = point.down ? interpolate(t - point.since, [0, 90], [0, 1], clamp01) : interpolate(t - point.since, [0, 120], [1, 0], clamp01);
  const look = director.lookAt(t);
  const stepIndex = tape.steps.findLastIndex((step) => step.t <= t);
  const step = tape.steps[stepIndex];
  const before = tape.steps[stepIndex - 1];

  return (
    <AbsoluteFill style={{ backgroundColor: INK, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: tape.viewport.width,
          height: tape.viewport.height,
          transformOrigin: '0 0',
          transform: `translate(${-shot.x * scale}px, ${-shot.y * scale}px) scale(${scale})`,
        }}
      >
        <Img src={staticFile(`${id}/${image.file}`)} style={{ width: tape.viewport.width, height: tape.viewport.height, display: 'block' }} />
      </div>
      {look?.ring && <Spotlight rect={look.ring} shot={shot} scale={scale} t={t} look={look} unit={unit} />}
      {director.presses
        .filter((press) => t >= press.t && t - press.t < 520)
        .map((press) => {
          const at = toClip(shot, scale, press.x, press.y);
          return <Ripple key={press.t} x={at.x} y={at.y} age={t - press.t} unit={unit} />;
        })}
      <Cursor x={cursor.x} y={cursor.y} pressed={pressed} unit={unit} />
      {captions && step && before && <Caption key={before.t} number={stepIndex} text={before.text} age={t - before.t} leaving={t - step.t} unit={unit} />}
      {captions && step && <Caption key={step.t} number={stepIndex + 1} text={step.text} age={t - step.t - (before ? CAPTION_GAP_MS : 0)} unit={unit} />}
    </AbsoluteFill>
  );
}

export function HowTo({ id, captions, tape }: HowToProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const director = useMemo(() => (tape ? direct(tape, width / height, { inset: captions ? CAPTION_INSET : 0 }) : null), [tape, width, height, captions]);
  if (!tape || !director) return null;

  const t = (frame / fps) * 1000;
  const unit = width / 1280;
  // After the hold on the outcome, back to the opening shot: the loop starts where it ends.
  const end = tape.duration_ms + HOLD_MS;
  const back = interpolate(t, [end, end + LOOP_MS], [0, 1], { ...clamp01, easing: Easing.inOut(Easing.cubic) });
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <Scene id={id} tape={tape} director={director} captions={captions} t={Math.min(t, tape.duration_ms)} unit={unit} />
      {back > 0 && (
        <AbsoluteFill style={{ opacity: back }}>
          <Scene id={id} tape={tape} director={director} captions={captions} t={0} unit={unit} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
