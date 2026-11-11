/**
 * The faces on the call: the assistant's, in its own color with its mark, and yours, with your initials.
 * A soft light behind each moves with that voice, with no line around the face. While the assistant
 * speaks, its light follows its words. While you talk, yours follows your microphone, and the
 * assistant's follows you more softly: it is listening. When it thinks, three small lights chase each
 * other round it; when it works on the plan, its light holds steady.
 */
import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { initialsOf, readableInkOn } from '../presence/peers';
import type { Call, CallState } from './call';
import '../styles/rails.css';
import { RemyMark } from '../assistant/RemyMark';

export type Mood = 'joining' | 'leaving' | 'speaking' | 'listening' | 'thinking' | 'working' | 'idle';

export function useCallState(call: Call): CallState {
  return useSyncExternalStore(
    (listener) => call.subscribe(listener),
    () => call.state,
  );
}

/** Writes a level, 0 to 1, into a CSS property of the element on every frame, without a render. */
export function useLevel(ref: RefObject<HTMLElement | null>, read: () => number, property = '--level'): void {
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    let last = -1;
    const tick = () => {
      const value = Math.round(reader.current() * 100) / 100;
      if (value !== last && ref.current) {
        ref.current.style.setProperty(property, String(value));
        last = value;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ref, property]);
}

export function moodOf(state: CallState): Mood {
  if (state.presence === 'joining') return 'joining';
  if (state.presence === 'leaving') return 'leaving';
  if (state.speaking) return 'speaking';
  if (state.activity === 'listening' || state.youTalking) return 'listening';
  if (state.activity === 'thinking') return 'thinking';
  if (state.activity === 'working') return 'working';
  return 'idle';
}

/** What the assistant is doing, in a word or two. */
export function assistantDoing(state: CallState): string {
  switch (moodOf(state)) {
    case 'joining':
      return 'joining';
    case 'leaving':
      return 'left the call';
    case 'speaking':
      return 'speaking';
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'working':
      return 'on the plan';
    default:
      return 'on the call';
  }
}

export function AssistantFace({ call, state, size }: { call: Call; state: CallState; size: 'sm' | 'md' }) {
  const face = useRef<HTMLSpanElement>(null);
  const mood = moodOf(state);
  useLevel(face, () => (mood === 'speaking' ? call.assistantLevel() : mood === 'listening' ? call.yourLevel() * 0.6 : 0));
  return (
    <span ref={face} className={`rail-face-frame is-${size} is-${mood}`} aria-hidden="true">
      <span className="rail-face-aura" />
      <span className="rail-face is-assistant">
        <span className="rail-face-mark">
          <RemyMark motion={mood === 'thinking' || mood === 'working' ? 'work' : 'breath'} />
        </span>
      </span>
      <span className="rail-face-orbs">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function YourFace({ call, name, color }: { call: Call; name: string; color: string }) {
  const face = useRef<HTMLSpanElement>(null);
  useLevel(face, () => call.yourLevel());
  return (
    <span ref={face} className="rail-face-frame is-you is-md" style={{ '--ring': color, '--face-ink': readableInkOn(color) } as CSSProperties} aria-hidden="true">
      <span className="rail-face-aura" />
      <span className="rail-face">{initialsOf(name)}</span>
    </span>
  );
}

/** Five bars that move with your voice, like a microphone's meter on a call. */
export function Meter({ call }: { call: Call }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    const weights = [0.55, 0.85, 1, 0.8, 0.5];
    let frame = 0;
    const tick = (now: number) => {
      const level = call.yourLevel();
      const children = bars.current?.children;
      if (children) {
        for (let index = 0; index < children.length; index += 1) {
          // Each bar moves on its own a little, so the meter reads as a voice, not a block.
          const wobble = 0.75 + 0.25 * Math.sin(now * 0.021 + index * 1.7);
          const height = Math.max(0.16, Math.min(1, level * weights[index]! * wobble * 1.5));
          (children[index] as HTMLElement).style.transform = `scaleY(${height.toFixed(2)})`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [call]);
  return (
    <span className="rail-meter" ref={bars} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
