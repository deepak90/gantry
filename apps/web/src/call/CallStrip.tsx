/**
 * The call's controls, in two places and never in both.
 *
 * - Before the call, in the header (`CallEntry`): the spark button with Remy's mark, the same one voice mode
 *   starts its call with. "Call Remy", or "Join" when someone is on the call; "Joining…" while it joins. It bows
 *   out once you are on. On the hosted site, the session's minutes with Remy beside it (RemyMinutes.tsx): an orb and
 *   "4:12 left"; once they're used up, "No Remy minutes left" in the button's place.
 * - On the call, on the call bar with Remy and everyone's tiles (`CallBarControls`): the time left on a call with a
 *   limit (the orb and "4:12 left", amber in the last 30 seconds), your microphone, captions (CC) and Leave, quiet like voice mode's
 *   Live switch, and "Turn on sound" if the browser kept the sound off. Remy's seat on the bar (`RemySeat`) is the
 *   spark button again while she isn't on the call: "Remy is joining…" while she is on her way, "Call Remy" if she
 *   doesn't come.
 *
 * `data-testid="call-strip"`, with the call's status, your microphone and whether you host the call, is on the
 * header's entry before the call and on the bar's controls during it: one element at a time.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ASSISTANT_NAME } from '../assistant/identity';
import { SparkShell } from '../talk/controls';
import type { HeardMinutes } from './minutes';
import { RemyMinutesChip, RemyOrb } from './RemyMinutes';
import type { CallSession, CallSnapshot } from './session';
import { formatTimeLeft, isEnding, msLeft, spokenTimeLeft } from './time-left';
import type { StripView } from './view';

const EASE = [0.22, 1, 0.36, 1] as const;

/** The call's state, for whoever checks it (the end-to-end tests). */
function stripData(snapshot: CallSnapshot) {
  return {
    'data-testid': 'call-strip',
    'data-status': snapshot.status,
    'data-mic': snapshot.mic,
    'data-host': String(snapshot.host !== null && snapshot.host === snapshot.me),
  };
}

export interface CallEntryProps {
  snapshot: CallSnapshot;
  view: StripView;
  /** How many are on the call before you join it. */
  waiting: number;
  /** The session's minutes with Remy, where the site keeps them. */
  minutes?: HeardMinutes | null;
  /** A line about the call this tab just left on its own (away.ts), in place of the view's. */
  notice?: { text: string; title: string } | null;
  onStart(): void;
}

/** Before the call, in the header: "Call Remy" or "Join", the spark button with Remy's mark. */
export function CallEntry({ snapshot, view, waiting, minutes = null, notice = null, onStart }: CallEntryProps) {
  const reduce = useReducedMotion();
  const shown = view.start !== null || view.joining;
  const joinCount = view.start?.label === 'Join' && waiting > 0 ? waiting : 0;
  const note = notice ?? view.note;
  return (
    <div className="call-entry" {...(view.inCall ? {} : stripData(snapshot))}>
      {note && !view.inCall && (
        <span className="call-note" role="status" title={note.title} data-testid="call-note">
          {note.text}
        </span>
      )}
      {minutes && !view.inCall && <RemyMinutesChip minutes={minutes} />}
      <AnimatePresence initial={false}>
        {shown && (
          <motion.span
            key="start"
            className="talk-start"
            initial={reduce ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.86, y: 8, filter: 'blur(2px)' }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            <SparkShell
              state={view.joining ? 'connecting' : snapshot.status === 'failed' && !view.held ? 'failed' : 'off'}
              icon="remy"
              text={view.joining ? 'Joining…' : view.held ? view.held.text : (view.start?.label ?? 'Call Remy')}
              title={view.joining ? 'Joining the call' : view.held ? view.held.title : (view.start?.title ?? '')}
              label={joinCount > 0 ? `Join the call: ${joinCount} on it` : undefined}
              onPress={onStart}
              disabled={view.joining || view.held !== null}
              after={
                joinCount > 0 ? (
                  <span className="talk-spark-count" aria-hidden="true">
                    {joinCount}
                  </span>
                ) : undefined
              }
              testId={view.joining ? 'call-joining' : view.held ? 'call-held' : 'call-start'}
            />
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Remy's seat on the call bar while she isn't on the call, where her face will be: the spark button with her
 * mark. On her way, its rim races ("Remy is joining…"); late (or a call started without her), it calls her in.
 */
export function RemySeat({ seat, held = null, onCall }: { seat: StripView['seat']; held?: StripView['held']; onCall(): void }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {seat && (
        <motion.div
          key="seat"
          className="call-seat"
          initial={reduce ? false : { opacity: 0, scale: 0.6, width: 0 }}
          animate={{ opacity: 1, scale: 1, width: 'auto' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7, width: 0 }}
          transition={{ duration: reduce ? 0 : 0.42, ease: EASE }}
        >
          <SparkShell
            state={seat === 'joining' ? 'connecting' : 'off'}
            icon="remy"
            text={seat === 'joining' ? `${ASSISTANT_NAME} is joining…` : seat === 'held' ? (held?.text ?? `${ASSISTANT_NAME} is unavailable`) : `Call ${ASSISTANT_NAME}`}
            title={seat === 'joining' ? `${ASSISTANT_NAME} is on her way` : seat === 'held' ? (held?.title ?? '') : `${ASSISTANT_NAME} isn't on the call. Ask her to join.`}
            onPress={onCall}
            disabled={seat === 'joining' || seat === 'held'}
            testId={seat === 'joining' ? 'call-remy-joining' : seat === 'held' ? 'call-remy-held' : 'call-remy'}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** This tab's clock, read again each time the shown second of the countdown to `endsAt` changes; still without one. */
function useCountdownNow(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      const left = endsAt - at;
      // Shown in whole seconds rounded up: the next change is when `left` crosses the next whole second.
      if (left > 0) timer = setTimeout(tick, (left % 1000 || 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [endsAt]);
  return now;
}

/**
 * The time left on a call with a limit: the orb running down and "4:12 left", calm, then amber in the last 30 seconds,
 * when Remy says she has to drop off. Every tab counts down to the moment her worker set (session.ts), so everyone on
 * the call sees the same; on the hosted site that is when the session's minutes with her run out, and the orb is full
 * to what's left of them (`totalMs`). Nothing on a call without a limit.
 */
export function CallClock({ endsAt, totalMs = null }: { endsAt: number | null; totalMs?: number | null }) {
  const now = useCountdownNow(endsAt);
  if (endsAt === null) return null;
  const left = msLeft(endsAt, now);
  const ending = isEnding(left);
  const whole = totalMs !== null && totalMs > 0 ? totalMs : null;
  return (
    <span
      className={`call-time${ending ? ' is-ending' : ''}`}
      role="timer"
      aria-label={spokenTimeLeft(left)}
      title={whole ? "Time left on this call: the session's minutes with Remy, the same for everyone on it" : 'Time left on this call, the same for everyone on it'}
      data-testid="call-time"
      data-ending={ending}
    >
      {whole && <RemyOrb fullness={Math.min(1, left / whole)} draining={left > 0} ending={ending} />}
      {formatTimeLeft(left)}
    </span>
  );
}

export interface CallBarControlsProps {
  session: CallSession;
  captions: boolean;
  onCaptions(on: boolean): void;
  /** The session's minutes with Remy in all, for the clock's orb; none where the site keeps none. */
  minutesTotalMs?: number | null;
}

/**
 * On the call, on the call bar: your microphone, captions and Leave. It reads the call itself, so it is right even
 * while the bar is on its way out after you leave.
 */
export function CallBarControls({ session, captions, onCaptions, minutesTotalMs = null }: CallBarControlsProps) {
  const snapshot = useSyncExternalStore(session.subscribe, () => session.snapshot);
  const onCall = snapshot.status === 'connected' || snapshot.status === 'reconnecting';
  const micOn = snapshot.mic === 'on';
  const micTrouble = snapshot.mic === 'blocked' || snapshot.mic === 'missing' || snapshot.mic === 'error';
  return (
    <div className="call-controls" {...(onCall ? stripData(snapshot) : {})}>
      {snapshot.status === 'reconnecting' && (
        <span className="call-status" role="status" title="The call dropped for a moment; it is coming back." data-testid="call-note">
          Reconnecting…
        </span>
      )}
      <CallClock endsAt={onCall ? snapshot.endsAt : null} totalMs={minutesTotalMs} />
      {snapshot.audioBlocked && (
        <button type="button" className="call-control" onClick={() => void session.enableAudio()} title="The browser kept the call's sound off" data-testid="call-sound">
          <i className="fa fa-volume-high" aria-hidden="true" />
          <span>Turn on sound</span>
        </button>
      )}
      <button
        type="button"
        className={`call-control is-icon call-mic${micTrouble ? ' is-trouble' : ''}`}
        aria-pressed={!micOn}
        aria-label="Mute"
        title={snapshot.micError ?? (micOn ? 'Mute your microphone' : 'Unmute your microphone')}
        disabled={snapshot.mic === 'starting'}
        onClick={() => void session.setMic(!micOn)}
        data-testid="call-mic"
      >
        <i className={`fa fa-${micOn ? 'microphone' : 'microphone-slash'}`} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="call-control is-icon call-cc"
        aria-pressed={captions}
        aria-label="Captions"
        title={captions ? 'Turn captions off' : 'Turn captions on'}
        onClick={() => onCaptions(!captions)}
        data-testid="call-captions"
      >
        <i className="fa fa-closed-captioning" aria-hidden="true" />
      </button>
      <button type="button" className="call-control call-leave" onClick={() => void session.leave()} title="Leave the call" data-testid="call-leave">
        <i className="fa fa-phone" aria-hidden="true" />
        <span>Leave</span>
      </button>
      {snapshot.micError && (
        <p className="call-popover" role="status" data-testid="call-mic-note">
          {snapshot.micError}
        </p>
      )}
    </div>
  );
}
