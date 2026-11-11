/**
 * How a visitor gets into a session (a copy of Harbor Street Offices) on the hosted site, outside React so each step
 * can be tested:
 *
 * - No sign-in: "Start a session", with Cloudflare Turnstile's check and a name from the list. Then an anonymous
 *   sign-in (with the check's token), claim_copy, and the workspace opens on that session.
 * - An invite link (`?join=<token>`): the same, then join_copy instead of claim_copy; the name suggested is one
 *   nobody in that session has.
 * - A code (`?code=482917` from the landing page, or typed on the welcome screen): the same, then join_copy_by_code.
 *   A code that matches no open session, too many wrong codes or a full session are said beside the code field.
 * - A sign-in and a session this browser remembers: touch_copy to see it is still there, then straight in. A session
 *   that was reset in the meantime says so, with "Start a new session".
 * - Every session in use: a calm screen saying so, with the film to watch meanwhile.
 *
 * The database gives a sign-in one session, ever (opening the one it holds again is no new one). So a session of
 * one's own starts from a sign-in that hasn't had one: one made on this page for it, else a new one, after signing
 * this tab out and passing the check again on the welcome screen. Start over, "Start a new session" after a reset,
 * and trying again when every session was in use always go that way. A network that started a session too lately,
 * or holds too many, waits: a calm screen counts down, with nothing to press until it is over.
 *
 * In the workspace: Start over (release_copy, then a new sign-in and a new session) and the lease running out (the
 * session was reset).
 */
import type { Session } from '@supabase/supabase-js';
import { FLAGS_OFF, isAllInUse, isSessionUsed, waitOf, CopyError, type AppFlags, type Copy, type Touch } from './rpc';
import { messageOf, reportError, type Reporter } from './report';
import { parseSessionCode } from './invite';

export type EntryMode = 'claim' | 'join' | 'code';

export type EntryState =
  | { kind: 'checking' }
  /**
   * Before a session: start one, join the one an invite is for, or join with a code; the human check first when it
   * needs a sign-in (any, to join; one that hasn't had a session, to start one). `signedIn`: no check is needed.
   * `again`: a new session after one ended here (Start over, a reset). `taken`: names in use in the invite's
   * session, so the screen suggests a free one. `code`: what the code field starts with (from the address, or the
   * code just tried). `name`: the name picked on a try before, or the one the person had.
   */
  | {
      kind: 'welcome';
      mode: EntryMode;
      signedIn: boolean;
      again: boolean;
      error: string | null;
      taken: readonly string[];
      code: string | null;
      name: string | null;
    }
  | { kind: 'working'; title: string }
  /** Every session is in use. */
  | { kind: 'busy' }
  /** The session this browser was in has been reset. */
  | { kind: 'reset' }
  /** An invite link that didn't work, in the server's words (the session is full, or it was reset). */
  | { kind: 'refused'; message: string }
  /** Too soon for another session from this network: when it may start (ms since the epoch), and why. */
  | { kind: 'wait'; until: number; reason: string | null }
  | { kind: 'error'; message: string }
  /** In a session. `generation` counts the sessions opened here, so each one starts a fresh workspace. */
  | { kind: 'ready'; session: Session; copy: Copy; flags: AppFlags; generation: number };

export interface EntryDeps {
  getSession(): Promise<Session | null>;
  signInAnonymously(captchaToken: string | null): Promise<Session>;
  /** Signs this tab out, here only (the server forgets this sign-in's session; other sign-ins are untouched). */
  signOut(): Promise<void>;
  /** A name from the list, or null to keep the one the person has (or get a free one). */
  claimCopy(name: string | null): Promise<Copy>;
  joinCopy(token: string, name: string | null): Promise<Copy>;
  joinCopyByCode(code: string, name: string | null): Promise<Copy>;
  /** The names in use in the session an invite token is for; none when that can't be told. */
  namesTaken(token: string): Promise<string[]>;
  touchCopy(projectId: string): Promise<Touch>;
  releaseCopy(projectId: string): Promise<void>;
  loadFlags(): Promise<AppFlags>;
  readCopy(userId: string): Copy | null;
  writeCopy(userId: string, copy: Copy): void;
  forgetCopy(): void;
  /** The invite in the address when the page opened, if any. */
  joinToken: string | null;
  /** The session code in the address when the page opened, if any. */
  joinCode: string | null;
  /** Takes the invite and the code out of the address once used (or set aside). */
  clearInvite(): void;
  report: Reporter;
  /** The time (ms since the epoch); a test passes its own. */
  now?(): number;
}

/** One way into a session of one's own: welcome (the first screen), a new one after a reset or a refusal, or Start over. */
type Via = 'welcome' | 'new' | 'start_over';

const WORKING: Record<EntryMode, string> = { claim: 'Starting your session…', join: 'Joining the session…', code: 'Joining the session…' };

export class CopyEntry {
  private current: EntryState = { kind: 'checking' };
  private readonly listeners = new Set<() => void>();
  private session: Session | null = null;
  /** The sign-in was made on this page and hasn't had a session yet, so it may start one. */
  private fresh = false;
  /** Signing this tab out: the sign-out it causes is this page's own step, not the end of the visit. */
  private signingOut = false;
  /** How the session about to be started was asked for. */
  private via: Via = 'welcome';
  /** The session about to be started follows one that ended here (Start over, a reset). */
  private again = false;
  private joinToken: string | null;
  private joinCode: string | null;
  /** The name picked on the welcome screen, or the one the person had: asked for in every claim and join from here. */
  private name: string | null = null;
  private generation = 0;
  private started = false;
  private readonly deps: EntryDeps;

  constructor(deps: EntryDeps) {
    this.deps = deps;
    this.joinToken = deps.joinToken;
    this.joinCode = deps.joinToken ? null : deps.joinCode;
  }

  get state(): EntryState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): EntryState => this.current;

  private set(state: EntryState): void {
    this.current = state;
    for (const listener of [...this.listeners]) listener();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private welcome(mode: EntryMode, error: string | null = null, taken: readonly string[] = [], code: string | null = null): void {
    this.set({
      kind: 'welcome',
      mode,
      signedIn: this.session !== null && (mode !== 'claim' || this.fresh),
      again: this.again,
      error,
      taken,
      code: mode === 'code' ? code : null,
      name: this.name,
    });
  }

  /** The first look: who is signed in, and which session this browser is in. Once (React may ask twice in development). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    return this.look();
  }

  private async look(): Promise<void> {
    this.set({ kind: 'checking' });
    let session: Session | null = null;
    try {
      session = await this.deps.getSession();
    } catch {
      session = null;
    }
    this.session = session;
    // A sign-in from before this page may have had its session already.
    this.fresh = false;
    if (this.joinToken) this.deps.report('join_opened', { signed_in: session !== null, via: 'link' });
    else if (this.joinCode) this.deps.report('join_opened', { signed_in: session !== null, via: 'code' });
    if (!session) {
      if (this.joinToken) return this.welcome('join', null, await this.deps.namesTaken(this.joinToken));
      return this.joinCode ? this.welcome('code', null, [], this.joinCode) : this.welcome('claim');
    }
    const stored = this.deps.readCopy(session.user.id);
    const ownInvite = stored !== null && ((this.joinToken !== null && this.joinToken === stored.joinToken) || (this.joinCode !== null && this.joinCode === stored.code));
    if (stored && (ownInvite || (this.joinToken === null && this.joinCode === null))) return this.resume(session, stored);
    if (this.joinToken) return this.join(session, this.joinToken);
    if (this.joinCode) return this.joinByCode(session, this.joinCode);
    this.welcome('claim');
  }

  /**
   * The welcome screen's button: sign in anonymously first (with the human check's token) if needed. `name` is the one
   * picked from the list; `code` is what was typed in the code field.
   */
  async go(captchaToken: string | null, name: string | null = null, code: string | null = null): Promise<void> {
    if (this.current.kind !== 'welcome') return;
    const { mode, taken } = this.current;
    if (name) this.name = name;
    const typed = mode === 'code' ? parseSessionCode(code) : null;
    if (mode === 'code' && typed === null) return this.welcome('code', 'Enter the 6-digit code you were given.', taken, code);
    this.set({ kind: 'working', title: mode === 'claim' && this.via === 'start_over' ? 'Starting over…' : WORKING[mode] });
    // A session of one's own needs a sign-in that hasn't had one: a new one, with this check's token.
    if (mode === 'claim' && !this.fresh) await this.dropSignIn();
    let session = this.session;
    if (!session) {
      try {
        session = await this.deps.signInAnonymously(captchaToken);
        this.session = session;
        this.fresh = true;
      } catch (error) {
        reportError('sign_in', error, this.deps.report);
        return this.welcome(mode, messageOf(error), taken, code);
      }
    }
    if (mode === 'join' && this.joinToken) return this.join(session, this.joinToken);
    if (mode === 'code' && typed) return this.joinByCode(session, typed);
    return this.claim(session, this.via);
  }

  /** From an invite's or a code's welcome: a session of your own instead. */
  chooseOwn(): void {
    if (this.current.kind !== 'welcome' || this.current.mode === 'claim') return;
    this.dropInvite();
    this.welcome('claim');
  }

  /** From the welcome screen: join someone's session with the code they gave you instead. */
  chooseCode(): void {
    if (this.current.kind !== 'welcome' || this.current.mode !== 'claim') return;
    this.welcome('code');
  }

  /**
   * A session of one's own: after a reset, while every session was in use, or for an invite that didn't work. After a
   * reset or a full pool, always from a new sign-in and check; for a refused invite, the sign-in made here to join may
   * start one, as it hasn't had a session.
   */
  async newCopy(): Promise<void> {
    const from = this.current.kind;
    if (from !== 'reset' && from !== 'busy' && from !== 'refused' && from !== 'error') return;
    this.dropInvite();
    this.again = from === 'reset';
    return this.ownSession('new', from === 'reset' || from === 'busy');
  }

  /** The wait is over: the session it was for, from the sign-in that waited (or a new one). Nothing before then. */
  async afterWait(): Promise<void> {
    if (this.current.kind !== 'wait' || this.now() < this.current.until) return;
    return this.ownSession(this.via);
  }

  /** After an error: the first look again. */
  async retry(): Promise<void> {
    if (this.current.kind !== 'error') return;
    return this.look();
  }

  /**
   * Start over: the session goes back to how it started, for everyone in it, this tab signs out, and the welcome
   * screen asks for the check again, under the name the person had, before a new sign-in starts a fresh session.
   */
  async startOver(): Promise<void> {
    if (this.current.kind !== 'ready') return;
    const { copy } = this.current;
    this.set({ kind: 'working', title: 'Starting over…' });
    try {
      await this.deps.releaseCopy(copy.projectId);
    } catch (error) {
      // Its lease runs out on its own; a fresh session is what was asked for.
      reportError('release', error, this.deps.report);
    }
    this.deps.forgetCopy();
    this.deps.report('copy_reset', { reason: 'start_over' });
    if (copy.name) this.name = copy.name;
    this.again = true;
    return this.ownSession('start_over', true);
  }

  /** From a session that won't open: a new one of your own, leaving that one as it is (it may be someone else's). */
  async leave(): Promise<void> {
    if (this.current.kind !== 'ready') return;
    const { copy } = this.current;
    this.deps.forgetCopy();
    if (copy.name) this.name = copy.name;
    this.again = true;
    return this.ownSession('new', true);
  }

  /** The session's lease ran out, or it was reset: say so, and offer a new one. */
  leaseLost(): void {
    if (this.current.kind !== 'ready') return;
    this.deps.forgetCopy();
    this.deps.report('copy_reset', { reason: 'lease' });
    this.set({ kind: 'reset' });
  }

  /** The sign-in ended (signed out somewhere): back to the start. This page's own signing out is not that. */
  signedOut(): void {
    if (this.signingOut) return;
    this.session = null;
    this.fresh = false;
    this.via = 'welcome';
    this.again = false;
    this.deps.forgetCopy();
    this.welcome('claim');
  }

  private dropInvite(): void {
    if (this.joinToken === null && this.joinCode === null) return;
    this.joinToken = null;
    this.joinCode = null;
    this.deps.clearInvite();
  }

  /**
   * A session of one's own, from a sign-in that hasn't had one: this page's own if it may (`renew` never lets it),
   * else this tab signs out and the welcome screen asks for the check before a new sign-in.
   */
  private async ownSession(via: Via, renew = false): Promise<void> {
    this.via = via;
    if (!renew && this.session && this.fresh) return this.claim(this.session, via);
    this.set({ kind: 'working', title: via === 'start_over' ? 'Starting over…' : WORKING.claim });
    await this.dropSignIn();
    this.welcome('claim');
  }

  /** Signs this tab out, so the next session starts from a new sign-in. A sign-out that fails is let be: the new sign-in takes its place. */
  private async dropSignIn(): Promise<void> {
    this.fresh = false;
    if (!this.session) return;
    this.session = null;
    this.signingOut = true;
    try {
      await this.deps.signOut();
    } catch (error) {
      reportError('sign_out', error, this.deps.report);
    } finally {
      this.signingOut = false;
    }
  }

  private async resume(session: Session, stored: Copy): Promise<void> {
    this.set({ kind: 'working', title: 'Opening your session…' });
    let touch: Touch;
    try {
      touch = await this.deps.touchCopy(stored.projectId);
    } catch (error) {
      if (error instanceof CopyError && error.refused) {
        // Nobody kept it, so it was reset.
        this.deps.forgetCopy();
        this.dropInvite();
        this.deps.report('copy_reset', { reason: 'lease' });
        return this.set({ kind: 'reset' });
      }
      reportError('touch', error, this.deps.report);
      return this.set({ kind: 'error', message: `Your session could not be reached: ${messageOf(error)}` });
    }
    this.dropInvite();
    const copy: Copy = { ...stored, leaseUntil: touch.leaseUntil ?? stored.leaseUntil, code: touch.code ?? stored.code };
    this.deps.writeCopy(session.user.id, copy);
    return this.open(session, copy);
  }

  private async claim(session: Session, via: Via): Promise<void> {
    this.set({ kind: 'working', title: via === 'start_over' ? 'Starting over…' : WORKING.claim });
    let copy: Copy;
    try {
      copy = await this.deps.claimCopy(this.name);
    } catch (error) {
      const wait = waitOf(error);
      if (wait) {
        this.deps.report('copy_wait', { reason: wait.reason ?? 'unknown' });
        return this.set({ kind: 'wait', until: this.now() + wait.seconds * 1000, reason: wait.reason });
      }
      // This sign-in had its session after all (in another tab, say): a new one, from the welcome screen.
      if (isSessionUsed(error)) return this.ownSession(via, true);
      if (isAllInUse(error)) return this.set({ kind: 'busy' });
      reportError('claim', error, this.deps.report);
      return this.set({ kind: 'error', message: messageOf(error) });
    }
    this.fresh = false;
    this.via = 'welcome';
    this.again = false;
    this.name = copy.name ?? this.name;
    this.deps.writeCopy(session.user.id, copy);
    this.deps.report('copy_claimed', { via });
    return this.open(session, copy);
  }

  private async join(session: Session, token: string): Promise<void> {
    this.set({ kind: 'working', title: WORKING.join });
    let copy: Copy;
    try {
      copy = await this.deps.joinCopy(token, this.name);
    } catch (error) {
      reportError('join', error, this.deps.report);
      return this.set(error instanceof CopyError && error.refused ? { kind: 'refused', message: error.message } : { kind: 'error', message: messageOf(error) });
    }
    this.dropInvite();
    this.name = copy.name ?? this.name;
    this.deps.writeCopy(session.user.id, copy);
    return this.open(session, copy);
  }

  /** A code that doesn't open a session is said beside the code field, to correct it there. */
  private async joinByCode(session: Session, code: string): Promise<void> {
    this.set({ kind: 'working', title: WORKING.code });
    let copy: Copy;
    try {
      copy = await this.deps.joinCopyByCode(code, this.name);
    } catch (error) {
      reportError('join_code', error, this.deps.report);
      if (!(error instanceof CopyError && error.refused)) return this.set({ kind: 'error', message: messageOf(error) });
      this.dropInvite();
      return this.welcome('code', error.message, [], code);
    }
    this.dropInvite();
    this.name = copy.name ?? this.name;
    this.deps.writeCopy(session.user.id, copy);
    return this.open(session, copy);
  }

  private async open(session: Session, copy: Copy): Promise<void> {
    let flags = FLAGS_OFF;
    try {
      flags = await this.deps.loadFlags();
    } catch (error) {
      // Nothing live is offered; the plan works without it.
      reportError('flags', error, this.deps.report);
    }
    this.generation += 1;
    this.set({ kind: 'ready', session, copy, flags, generation: this.generation });
  }
}
