/**
 * The how-to card: a short recording of the real app (apps/web/public/clips, made by `pnpm clips`)
 * with its steps under it, shown when someone asks the assistant how to do something. The clip loads
 * only once the card is in view (`preload="none"`; the poster, the clip's last frame, stands in until
 * then), plays muted and looped while it is in view and pauses when it scrolls away. With reduced
 * motion it stays on the poster with a play button. A button pauses it, or plays it again, at any time.
 */
import { useEffect, useRef, useState } from 'react';
import { CLIP_ID_PATTERN, clipFiles, type HowToCard } from '@collab/shared';
import { CardShell, type CardEnv } from './cards';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Whether the viewer asked for less motion (follows the setting while the card is open). */
export function useReducedMotion(): boolean {
  const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null);
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return undefined;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/** Where the web app serves a clip's files (under its base URL). */
export function clipUrls(id: string): { video: string; poster: string } {
  const base = import.meta.env.BASE_URL ?? '/';
  const files = clipFiles(id);
  return { video: `${base}${files.video}`, poster: `${base}${files.poster}` };
}

export function HowToCardView({ card, env }: { card: Partial<HowToCard>; env: CardEnv }) {
  const id = typeof card.clip_id === 'string' && CLIP_ID_PATTERN.test(card.clip_id) ? card.clip_id : null;
  const steps = Array.isArray(card.steps) ? card.steps.filter((step): step is string => typeof step === 'string') : [];
  return (
    <CardShell kind="how" icon="circle-play" kicker="How to" env={env} testId="assistant-how-card">
      <h4 className="ac-title">{card.title ?? <span className="ac-skeleton" />}</h4>
      {id ? <ClipPlayer id={id} title={card.title ?? 'How to'} /> : <div className="ac-how-clip is-waiting" aria-hidden="true" />}
      {steps.length > 0 && (
        <ol className="ac-how-steps" aria-label="Steps">
          {steps.map((step, index) => (
            <li key={`${index}:${step}`}>{step}</li>
          ))}
        </ol>
      )}
    </CardShell>
  );
}

function ClipPlayer({ id, title }: { id: string; title: string }) {
  const { video: src, poster } = clipUrls(id);
  const figure = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The viewer paused it: it stays paused when it comes back into view. */
  const [held, setHeld] = useState(false);
  const heldNow = useRef(held);
  heldNow.current = held;

  const play = () => {
    const element = video.current;
    if (!element) return;
    // A browser may refuse to start it (data saver, a policy): the play button stays.
    void element.play()?.catch?.(() => setPlaying(false));
  };

  // Plays while in view (unless the viewer asked for less motion or paused it), pauses out of view.
  useEffect(() => {
    const element = figure.current;
    if (!element) return undefined;
    const seen = (inView: boolean) => {
      if (inView && !reduced && !heldNow.current) play();
      if (!inView) video.current?.pause();
    };
    if (typeof IntersectionObserver === 'undefined') {
      seen(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => seen(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)), { threshold: [0, 0.5, 1] });
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduced, src]);

  // Less motion asked for while it plays: stop on the frame it is on.
  useEffect(() => {
    if (reduced) video.current?.pause();
  }, [reduced]);

  const toggle = () => {
    if (playing) {
      setHeld(true);
      video.current?.pause();
    } else {
      setHeld(false);
      play();
    }
  };

  return (
    <figure ref={figure} className={`ac-how-clip${playing ? ' is-playing' : ''}`} data-testid="assistant-how-clip">
      <video
        ref={video}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="none"
        disablePictureInPicture
        aria-label={`Screen recording: ${title}`}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      {failed ? (
        <figcaption className="ac-how-failed">The clip could not be loaded.</figcaption>
      ) : !playing && (reduced || held) ? (
        <button type="button" className="ac-how-play" onClick={toggle} aria-label={`Play the clip: ${title}`} data-testid="assistant-how-play">
          <i className="fa fa-play" aria-hidden="true" />
        </button>
      ) : (
        <div className="ac-how-controls">
          <button type="button" className="button is-icon is-sm" onClick={toggle} aria-label={playing ? 'Pause the clip' : 'Play the clip'} data-testid="assistant-how-toggle">
            <i className={`fa fa-${playing ? 'pause' : 'play'}`} aria-hidden="true" />
          </button>
          <a className="button is-icon is-sm" href={src} target="_blank" rel="noreferrer" aria-label="Watch it larger" title="Watch it larger">
            <i className="fa fa-up-right-and-down-left-from-center" aria-hidden="true" />
          </a>
        </div>
      )}
    </figure>
  );
}
