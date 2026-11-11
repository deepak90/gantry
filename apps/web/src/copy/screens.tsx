/**
 * The hosted site's screens before the workspace: starting a session (with Cloudflare's human check when it needs a
 * sign-in), joining one from an invite link or with a code, every session in use, a session that was reset, an invite
 * that didn't work, and a wait before another session can start from the visitor's network. Whoever comes in sees the
 * name they will have, from the list (names.ts), and can pick another. The same card as the shell's status screens.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { GantryMark } from '../app/GantryMark';
import { FILM_URL } from '../hosted';
import { parseSessionCode, typedSessionCode } from './invite';
import { nameSuggestions, seatTitle } from './names';
import { messageOf } from './report';
import { loadTurnstile, type TurnstileApi } from './turnstile';
import { JOIN_WITH_CODE, START_NEW_SESSION, START_SESSION } from './words';
import '../styles/copy.css';

function CopyCard({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <div className="login-screen copy-screen" data-testid={testId}>
      <section className="login-card copy-card" aria-label={title}>
        <div className="login-heading">
          <span className="app-logo" aria-hidden="true">
            <GantryMark />
          </span>
          <h1>{title}</h1>
        </div>
        {children}
      </section>
    </div>
  );
}

/**
 * Cloudflare Turnstile, rendered into this box. `onToken` gets each fresh token, and null when it expires or fails;
 * a new `resetKey` asks for a fresh check (a token is good for one sign-in).
 */
export function TurnstileCheck({ siteKey, onToken, resetKey = 0 }: { siteKey: string; onToken(token: string | null): void; resetKey?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const tell = useRef(onToken);
  tell.current = onToken;
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    loadTurnstile().then(
      (api) => {
        const box = host.current;
        if (gone || !box) return;
        const id = api.render(box, {
          sitekey: siteKey,
          action: 'get_copy',
          theme: 'light',
          size: 'flexible',
          'refresh-expired': 'auto',
          callback: (token) => {
            setProblem(null);
            tell.current(token);
          },
          'expired-callback': () => tell.current(null),
          'timeout-callback': () => tell.current(null),
          'error-callback': () => {
            tell.current(null);
            setProblem('The check didn’t go through. It tries again by itself; if it keeps failing, reload the page.');
          },
        });
        if (id) widget.current = { api, id };
      },
      (error: unknown) => {
        if (!gone) setProblem(messageOf(error));
      },
    );
    return () => {
      gone = true;
      const shown = widget.current;
      widget.current = null;
      if (shown) shown.api.remove(shown.id);
    };
  }, [siteKey]);

  useEffect(() => {
    const shown = widget.current;
    if (resetKey === 0 || !shown) return;
    tell.current(null);
    shown.api.reset(shown.id);
  }, [resetKey]);

  return (
    <div className="copy-check">
      <div ref={host} className="copy-check-widget" data-testid="turnstile" />
      {problem && (
        <p className="note is-warning is-sm" role="alert">
          <i className="fa fa-triangle-exclamation" aria-hidden="true" />
          <span>{problem}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The name this person will have, and "Another name" to go through the others nobody in the session has. The order
 * is shuffled once; a name that turns out to be taken gives way to the next free one.
 */
function useSeatName(taken: readonly string[], initial: string | null, random?: () => number) {
  const [order] = useState(() => nameSuggestions([], random));
  const [picked, setPicked] = useState<string | null>(initial);
  const free = order.filter((name) => !taken.includes(name));
  const name = picked !== null && free.includes(picked) ? picked : (free[0] ?? null);
  const another = () => {
    if (name === null || free.length < 2) return;
    setPicked(free[(free.indexOf(name) + 1) % free.length]!);
  };
  return { name, another, choices: free.length };
}

export interface WelcomeScreenProps {
  mode: 'claim' | 'join' | 'code';
  /** Signed in already, with a sign-in that may do this: no check needed. */
  signedIn: boolean;
  /** A new session after one ended here (Start over, a reset): said so in the title and the button. */
  again?: boolean;
  /** What went wrong with the last try, in the server's words. */
  error: string | null;
  /** The names in use in the session being joined: the name suggested is none of them. */
  taken?: readonly string[];
  /** What the code field starts with. */
  code?: string | null;
  /** The name picked before (kept when the screen comes back after a try), if it is still free. */
  name?: string | null;
  /** Turnstile's site key; without one, no check is shown (a stack without captcha). */
  siteKey: string | null;
  /** The button: the check's token, the name picked, and the code typed (code mode). */
  onGo(captchaToken: string | null, name: string | null, code: string | null): void;
  /** From an invite or a code: a session of your own instead. */
  onChooseOwn(): void;
  /** From "Start a session": join with a code instead. */
  onChooseCode(): void;
  /** Shuffles the names; a test passes a fixed one. */
  random?: () => number;
}

const TITLES = { claim: START_SESSION, join: 'Join a session', code: JOIN_WITH_CODE } as const;

export function WelcomeScreen({ mode, signedIn, again = false, error, taken = [], code = null, name = null, siteKey, onGo, onChooseOwn, onChooseCode, random }: WelcomeScreenProps) {
  const start = again ? START_NEW_SESSION : START_SESSION;
  const checking = !signedIn && siteKey !== null;
  const [token, setToken] = useState<string | null>(null);
  // A failed try used its token up: the check runs again.
  const [resetKey, setResetKey] = useState(0);
  const lastError = useRef(error);
  useEffect(() => {
    if (error && error !== lastError.current && checking) setResetKey((key) => key + 1);
    lastError.current = error;
  }, [error, checking]);
  const seat = useSeatName(taken, name, random);
  const [typed, setTyped] = useState(() => typedSessionCode(code ?? ''));
  const codeField = useRef<HTMLInputElement>(null);
  const ids = useId();
  const coding = mode === 'code';
  useEffect(() => {
    if (coding) codeField.current?.focus();
  }, [coding]);

  const ready = !(checking && token === null) && (!coding || parseSessionCode(typed) !== null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onGo(checking ? token : null, seat.name, coding ? typed : null);
  };

  return (
    <CopyCard title={mode === 'claim' ? start : TITLES[mode]} testId="copy-welcome">
      <form className="copy-welcome" onSubmit={submit} noValidate>
        {mode === 'claim' && (
          <p className="login-lead">A private session on the Harbor Street Offices plan, yours for this visit. Change anything in it and invite a teammate to join you. It resets after you leave.</p>
        )}
        {mode === 'join' && (
          <p className="login-lead">You were invited to a private session on the Harbor Street Offices plan. Everyone in it sees the same plan, live, and each change as it is made.</p>
        )}
        {coding && (
          <div className="field copy-code-field">
            <label className="field-label" htmlFor={`${ids}-code`}>
              Session code
            </label>
            <input
              ref={codeField}
              id={`${ids}-code`}
              className="input copy-code-input"
              value={typed}
              onChange={(event) => setTyped(typedSessionCode(event.target.value))}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="123 456"
              aria-describedby={`${ids}-code-hint${error ? ` ${ids}-error` : ''}`}
              aria-invalid={error ? true : undefined}
              data-testid="copy-code"
            />
            <span className="field-hint" id={`${ids}-code-hint`}>
              The 6 digits from the person who invited you.
            </span>
          </div>
        )}
        {error && (
          <p className="note is-danger login-error" role="alert" id={`${ids}-error`} data-testid="copy-error">
            {error}
          </p>
        )}
        {seat.name && (
          <div className="copy-who" data-testid="copy-who">
            <p>
              <span className="copy-who-label">You’ll join as</span>{' '}
              <span>
                <strong data-testid="copy-name">{seat.name}</strong>, {seatTitle(mode === 'claim')}.
              </span>
            </p>
            {seat.choices > 1 && (
              <button type="button" className="button is-link copy-who-other" onClick={seat.another} data-testid="copy-other-name">
                Another name
              </button>
            )}
          </div>
        )}
        {checking && <TurnstileCheck siteKey={siteKey} onToken={setToken} resetKey={resetKey} />}
        <button type="submit" className="button is-primary is-lg is-block" disabled={!ready} data-testid="copy-go">
          {mode === 'claim' ? start : 'Join this session'}
        </button>
        <p className="copy-desktop-note">Best on a computer: the plan needs a wide screen.</p>
        {mode === 'claim' ? (
          <p className="copy-aside">
            Have a code from a teammate?{' '}
            <button type="button" className="button is-link" onClick={onChooseCode} data-testid="copy-use-code">
              {JOIN_WITH_CODE}
            </button>
          </p>
        ) : (
          <p className="copy-aside">
            <button type="button" className="button is-link" onClick={onChooseOwn} data-testid="copy-own-instead">
              Start a session of your own instead
            </button>
          </p>
        )}
      </form>
    </CopyCard>
  );
}

/** Every session is in use: a calm word, and the film meanwhile. */
export function BusyScreen({ onRetry }: { onRetry(): void }) {
  return (
    <CopyCard title="Every session is in use" testId="copy-busy">
      <p className="login-lead">All sessions are in use right now. Try again in a few minutes.</p>
      <div className="status-actions">
        <a className="button is-primary" href={FILM_URL} data-testid="copy-film">
          Watch the film
        </a>
        <button type="button" className="button" onClick={onRetry} data-testid="copy-retry">
          Try again
        </button>
      </div>
    </CopyCard>
  );
}

/** Why a network waits for its next session, by the reason the database gives (claim_copy). */
const WAIT_REASONS = new Map<string, string>([
  ['gap', 'A session was just started on your network. The next one can start a couple of minutes after it.'],
  ['hour', 'Your network has started several sessions in the last hour.'],
  ['day', 'Your network has started many sessions today.'],
  ['held', 'Your network already has as many sessions open as it can. A new one can start as soon as one of them ends.'],
]);
const WAIT_ANY = 'Each network can start only so many sessions, to keep the demo open for everyone.';

/** A wait as the countdown shows it: "1:45" under an hour, "about 3 hours" past one. */
export function waitText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Too soon for another session from this network: why, and a countdown to when one can start, with nothing to press
 * until it is over; then "Start a new session". The film meanwhile.
 */
export function WaitScreen({ until, reason, onDone, now = Date.now }: { until: number; reason: string | null; onDone(): void; now?: () => number }) {
  const [left, setLeft] = useState(() => until - now());
  useEffect(() => {
    if (until - now() <= 0) return;
    const timer = window.setInterval(() => {
      const remaining = until - now();
      setLeft(remaining);
      if (remaining <= 0) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [until, now]);
  const done = left <= 0;
  return (
    <CopyCard title={START_NEW_SESSION} testId="copy-wait">
      <p className="login-lead">{done ? 'You can start a new session now.' : ((reason && WAIT_REASONS.get(reason)) ?? WAIT_ANY)}</p>
      {done ? (
        <button type="button" className="button is-primary is-lg is-block" onClick={onDone} data-testid="copy-new">
          {START_NEW_SESSION}
        </button>
      ) : (
        <p className="copy-countdown" role="timer" data-testid="copy-countdown">
          You can start a new session in <strong>{waitText(left)}</strong>
        </p>
      )}
      <div className="status-actions">
        <a className="button" href={FILM_URL} data-testid="copy-film">
          Watch the film
        </a>
      </div>
    </CopyCard>
  );
}

/** The session went back to how it started (nobody kept it, or someone started over). */
export function ResetScreen({ onNewCopy }: { onNewCopy(): void }) {
  return (
    <CopyCard title="This session was reset" testId="copy-reset">
      <p className="login-lead">A session goes back to how it started when nobody has been in it for a while, or when someone in it starts over.</p>
      <button type="button" className="button is-primary is-lg is-block" onClick={onNewCopy} data-testid="copy-new">
        {START_NEW_SESSION}
      </button>
    </CopyCard>
  );
}

/** An invite link that didn't work, in the server's words. */
export function RefusedScreen({ message, onOwn }: { message: string; onOwn(): void }) {
  return (
    <CopyCard title="This invite didn’t work" testId="copy-refused">
      <p className="note is-warning login-error" role="alert" data-testid="copy-refused-message">
        {message}
      </p>
      <button type="button" className="button is-primary is-lg is-block" onClick={onOwn} data-testid="copy-new">
        Start a session of your own
      </button>
    </CopyCard>
  );
}
