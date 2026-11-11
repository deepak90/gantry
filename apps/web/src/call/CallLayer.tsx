/**
 * A real call with Remy: the people in the project talk to each other and to Remy, each from their own tab. On this
 * machine it is the dev server's, with `?call` in the address; on the hosted site it is there for everyone in the
 * copy while calls are switched on (app_flags.live_calls). Before the call, the header has the spark button that
 * starts or joins it; on the call, the call bar low on the screen grows into the call panel: Remy's face, one tile per
 * person, the call's captions and its controls (CallStrip.tsx). A local production build leaves all of it out.
 *
 * What you say to Remy goes to the thread from your tab, as your message said aloud. The host (whoever
 * started the call) hands Remy's answers to her voice. The dev server (call-dev.ts), or the hosted site's own
 * routes, mint the call's tokens and send Remy's worker to the room (endpoints.ts).
 *
 * Once she is on the call, a short strip over the call bar says what to ask her and how (CallTip.tsx); a call with a
 * time limit shows the time left on the bar (CallStrip.tsx).
 *
 * On the hosted site the session has five minutes with Remy on calls in all, kept by the site (minutes.ts): the header
 * shows them as an orb beside the call button, and puts the button away once they're used up. A call is for the tab in
 * front (away.ts): a tab left in the background leaves its call. When a call ends, the tab asks the site about the room
 * again at once and once Remy has had time to leave, even from the background, so the site counts the call's minutes
 * as soon as she is off it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { mirrorCall } from '../assistant/attention';
import { ASSISTANT_NAME } from '../assistant/identity';
import type { AssistantSession } from '../assistant/session';
import { report } from '../copy/report';
import { HOSTED, readHostedConfig } from '../hosted';
import { Call } from '../rails/call';
import { Hand } from '../rails/hand';
import { RailCall } from '../rails/RailCall';
import { reportCalls } from './call-report';
import { useCaptionsShown } from './captions';
import { CallBarControls, CallEntry, RemySeat } from './CallStrip';
import { CallTiles } from './CallTiles';
import { CallTip } from './CallTip';
import { awayNote, watchAway, type AwayReason } from './away';
import { watchTabs, type Tabs } from './tabs';
import { callEndpoints, CallRefusedError, requestCallToken, requestRoom } from './endpoints';
import { followRemy } from './face';
import { glowSpeakers } from './glow';
import { blockHold, holdOf, holdReason, minutesHold, refusalCode, type CallHold, type Refusal } from './hold';
import { minutesSpent, type HeardMinutes } from './minutes';
import type { CallNotice } from '../rails/RailCall';
import { liveCall } from './live';
import { HOSTED_LINE_CHARS } from './protocol';
import { CallSession } from './session';
import { linkThread, type ThreadLink } from './thread';
import { humansOf, stripOf, type RoomNews } from './view';
import '../styles/talk.css';
import '../styles/call.css';

export interface CallLayerProps {
  projectId: string;
  /** This tab's presence session id: its identity on the call. */
  sessionId: string;
  name: string;
  /** The person's cursor color. */
  color: string;
  role: string;
  /** A simulated person: an AI voice. */
  sim: boolean;
  assistant: AssistantSession | null;
  /** The walkthrough's call bar and Remy's hand, when it runs: the call panel is that call bar, grown. */
  rail?: { call: Call; hand: Hand } | null;
  /**
   * The call this tab hosts, while Remy is on it, and its conversation; null otherwise. Presence carries it, so
   * the assistant service greets the call when she joins.
   */
  onRemyCall?(call: { remy: boolean; thread: string | null } | null): void;
  /** The signed-in person's access token, for the hosted site's call routes. */
  accessToken?: () => Promise<string | null>;
  /** This tab joined the call. */
  onJoined?(): void;
}

/** How long after joining Remy may take before "Call Remy" is offered again. */
const REMY_GRACE_MS = 8000;
/** How long the call bar's notice about a refusal shows. */
const NOTICE_MS = 8000;
/** The notice's title when the server can't bring Remy in. */
export const UNAVAILABLE_NOW = `${ASSISTANT_NAME} is unavailable right now`;

/** What the call bar says about a refusal: Remy unavailable, and why, when it was about bringing her in (hold.ts); the server's own words otherwise. */
export function noticeOf(refusal: { message: string; status: number; code?: string | null }): CallNotice {
  const code = refusalCode({ status: refusal.status, code: refusal.code ?? null });
  return code ? { title: UNAVAILABLE_NOW, detail: holdReason(code) } : { title: "The call couldn't start", detail: refusal.message };
}

/** After a call ends, the tab asks about the room again this long after (ms): at once, and once Remy has left an empty room. */
export const AFTER_CALL_LOOKS_MS = [1_000, 20_000] as const;
/** How long the header says the tab left its call on its own. */
const AWAY_NOTE_MS = 30_000;
/** The whole of a session's minutes, when the site hasn't said yet (call-hosted.ts: five minutes). */
const MINUTES_TOTAL_MS = 300_000;

/** The call bar's notice after the server refused a place on the call, for a few seconds. Null once it has been said. */
export function useRefusalNotice(refusal: { message: string; status: number; code?: string | null; n: number } | null): CallNotice | null {
  const [notice, setNotice] = useState<CallNotice | null>(null);
  useEffect(() => {
    if (!refusal) return undefined;
    setNotice(noticeOf(refusal));
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [refusal]);
  return notice;
}

/** The hold a refusal puts on the call button (hold.ts), dropped by itself when its time is up. */
export function useCallHold(refusal: Refusal | null): CallHold | null {
  const [now, setNow] = useState(() => Date.now());
  const hold = holdOf(refusal, now);
  const until = hold?.until ?? null;
  useEffect(() => {
    if (until === null || !Number.isFinite(until)) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [until]);
  // A new refusal starts its own hold from now.
  useEffect(() => {
    if (refusal) setNow(Date.now());
  }, [refusal]);
  return hold;
}

export default function CallLayer({ projectId, sessionId, name, color, role, sim, assistant, rail = null, onRemyCall, accessToken, onJoined }: CallLayerProps) {
  // The dev server's routes on this machine; the site's own, signed with the person's token, on the hosted site.
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const endpoints = useMemo(() => callEndpoints({ hosted: HOSTED, accessToken: () => tokenRef.current?.() ?? Promise.resolve(null), livekitUrl: readHostedConfig().livekitUrl }), []);
  // The last refusal, in the server's words: the call bar says it, and one about bringing Remy in holds the button.
  const [refusal, setRefusal] = useState<(Refusal & { n: number }) | null>(null);
  const session = useMemo(
    () =>
      new CallSession({
        me: sessionId,
        // The hosted worker takes lines of at most 400 characters: a longer answer is handed over in parts.
        ...(HOSTED ? { maxLineChars: HOSTED_LINE_CHARS } : {}),
        fetchToken: async (options) => {
          try {
            return await requestCallToken(endpoints, { projectId, sessionId, name, color, role, sim, remy: options?.remy ?? true });
          } catch (error) {
            if (error instanceof CallRefusedError) setRefusal((last) => ({ message: error.message, status: error.status, code: error.code, until: error.until, at: Date.now(), n: (last?.n ?? 0) + 1 }));
            throw error;
          }
        },
      }),
    [endpoints, projectId, sessionId, name, color, role, sim],
  );
  const snapshot = useSyncExternalStore(session.subscribe, () => session.snapshot);
  const notice = useRefusalNotice(refusal);
  const hold = useCallHold(refusal);
  // The hosted site counts calls: when they start and end, how long, and how many were on them.
  useEffect(() => (HOSTED ? reportCalls(session, report) : undefined), [session]);

  // The walkthrough's call bar when it runs; otherwise this panel's own, with Remy's face over the 3D view following it.
  const own = useMemo(() => (rail ? null : { call: new Call({ name: ASSISTANT_NAME }), hand: new Hand({ name: ASSISTANT_NAME }) }), [rail]);
  const call = rail?.call ?? own!.call;
  const hand = rail?.hand ?? own!.hand;
  useEffect(() => {
    if (!own) return undefined;
    const stop = mirrorCall(own.call, own.hand);
    return () => {
      stop();
      own.hand.destroy();
    };
  }, [own]);
  // The captions' finished lines, for screen readers: one at a time, never the words still being made out.
  const [finalLine, setFinalLine] = useState<{ n: number; text: string } | null>(null);
  useEffect(() => followRemy(call, session, { onFinal: ({ name: who, text }) => setFinalLine((last) => ({ n: (last?.n ?? 0) + 1, text: `${who}: ${text}` })) }), [call, session]);
  useEffect(() => glowSpeakers(session), [session]);

  // What is said to Remy goes to the thread from the speaker's own tab; the host says her answers.
  const [link, setLink] = useState<ThreadLink | null>(null);
  useEffect(() => {
    if (!assistant) return undefined;
    // An answer cut off by people talking among themselves is finished once the floor is free (`resume`): a live test
    // heard a teammate's aside end her answer for good.
    const linked = linkThread(session, assistant, { resume: true, log: (event, data) => session.record(event, data) });
    setLink(linked);
    return () => {
      linked.stop();
      setLink(null);
    };
  }, [session, assistant]);

  // For the walkthrough: the live call's ears and voice.
  useEffect(() => {
    const live = {
      session,
      hear: session.hear.bind(session),
      say: session.say.bind(session),
      speakReplies: (on: boolean) => link?.speakReplies(on),
    };
    liveCall.set(live);
    return () => {
      if (liveCall.get() === live) liveCall.set(null);
    };
  }, [session, link]);

  // The call ends with the page.
  useEffect(() => {
    const leave = () => void session.leave();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [session]);

  // Before joining: is a call going, and who is on it? And the session's minutes with Remy, where the site keeps them.
  const [room, setRoom] = useState<RoomNews | null>(null);
  const [minutes, setMinutes] = useState<HeardMinutes | null>(null);
  // On the hosted site the button waits for the site's first word on the room, so a session whose minutes are used up
  // never shows a call button that then goes away.
  const [heard, setHeard] = useState(!HOSTED);
  const heardRoom = (news: RoomNews | null) => {
    setRoom(news);
    setHeard(true);
    if (news?.minutes) setMinutes({ ...news.minutes, at: Date.now() });
  };
  const heardRoomRef = useRef(heardRoom);
  heardRoomRef.current = heardRoom;
  const inCall = snapshot.status === 'connected' || snapshot.status === 'reconnecting';
  // On the call, what this person does in the plan is answered out loud.
  useEffect(() => {
    assistant?.setOnCall(inCall);
    return () => assistant?.setOnCall(false);
  }, [assistant, inCall]);
  // Remy on the call this tab hosts: said on presence (once each way), for the assistant service's greeting.
  const remyOnMyCall = inCall && snapshot.host === snapshot.me && snapshot.remy !== null && snapshot.remy !== 'joining';
  useEffect(() => {
    onRemyCall?.(remyOnMyCall ? { remy: true, thread: null } : null);
  }, [remyOnMyCall, onRemyCall]);
  useEffect(() => () => onRemyCall?.(null), [onRemyCall]);
  const joinedRef = useRef(onJoined);
  joinedRef.current = onJoined;
  useEffect(() => {
    if (inCall) joinedRef.current?.();
  }, [inCall]);
  useEffect(() => {
    if (inCall || snapshot.status === 'joining') return undefined;
    let alive = true;
    const look = async () => {
      if (document.hidden) return;
      const news = await requestRoom(endpoints, projectId);
      if (alive) heardRoomRef.current(news);
    };
    void look();
    const timer = window.setInterval(() => void look(), endpoints.pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [endpoints, projectId, inCall, snapshot.status]);

  // The call ended: ask about the room again at once and once Remy has had time to leave, from a tab in the background
  // too, so the site counts the call's minutes as soon as she's off it, and the orb shows what's left.
  const wasInCall = useRef(false);
  useEffect(() => {
    if (inCall) {
      wasInCall.current = true;
      return undefined;
    }
    if (!wasInCall.current || !HOSTED) return undefined;
    wasInCall.current = false;
    let alive = true;
    const timers = AFTER_CALL_LOOKS_MS.map((ms) =>
      window.setTimeout(() => {
        void requestRoom(endpoints, projectId).then((news) => {
          if (alive) heardRoomRef.current(news);
        });
      }, ms),
    );
    return () => {
      alive = false;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [inCall, endpoints, projectId]);

  // A call is for the tab in front: in the background too long, or too often, and this tab leaves it. Another of the
  // session's tabs in front in this browser (a teammate's, from Invite) counts as someone there.
  const tabsRef = useRef<Tabs | null>(null);
  useEffect(() => {
    if (!HOSTED) return undefined;
    const tabs = watchTabs(projectId);
    tabsRef.current = tabs;
    return () => {
      tabs.stop();
      tabsRef.current = null;
    };
  }, [projectId]);
  const [away, setAway] = useState<AwayReason | null>(null);
  useEffect(() => {
    if (!HOSTED || !inCall) return undefined;
    setAway(null);
    return watchAway(
      document,
      (why) => {
        setAway(why);
        session.record('call_left_away', { why });
        void session.leave();
      },
      { watchedElsewhere: () => tabsRef.current?.othersInFront() ?? false },
    );
  }, [inCall, session]);
  useEffect(() => {
    if (!away) return undefined;
    const timer = window.setTimeout(() => setAway(null), AWAY_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [away]);

  // On the call without Remy for a while: offer to call her in. Called in, she has a while to come first.
  const [remyLate, setRemyLate] = useState(false);
  const [remyCalls, setRemyCalls] = useState(0);
  useEffect(() => {
    if (!inCall) setRemyCalls(0);
  }, [inCall]);
  useEffect(() => {
    setRemyLate(false);
    if (!inCall || snapshot.remy !== null) return undefined;
    const timer = window.setTimeout(() => setRemyLate(true), REMY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [inCall, snapshot.remy, remyCalls]);
  const [captions, setCaptions] = useCaptionsShown();
  useEffect(() => {
    if (!inCall) setFinalLine(null);
  }, [inCall]);

  // A Remy who is leaving, or stuck without a state (her worker hung), is no Remy: "Call Remy" sends her again.
  const remyHere = snapshot.remy !== null && !snapshot.remyStuck;
  // Used-up minutes hold the button for the rest of the visit, as the site's refusal would; and while the site says a call
  // can't be had now (its day used up, Remy busy, the session's calls used up), the button is held and greyed before
  // anyone presses it.
  const held = minutesSpent(minutes) ? minutesHold(minutes!.totalMs) : room?.blocked ? blockHold(room.blocked, Date.now()) : hold;
  const view = stripOf({ status: snapshot.status, error: snapshot.error, room, remyHere, remyLate: remyLate || snapshot.remyStuck, hosted: HOSTED, hold: held });
  // Until the site has said anything about the room, nothing to press.
  const entryView = heard || view.inCall || view.joining ? view : { ...view, start: null };
  // The orb in the header: what the site said, or, refused for used-up minutes before it said, an empty one.
  const entryMinutes = minutes ?? (held?.code === 'minutes_spent' ? { totalMs: MINUTES_TOTAL_MS, leftMs: 0, going: false, at: 0 } : null);
  const people = humansOf(snapshot.people);
  const callRemy = () => {
    setRemyCalls((calls) => calls + 1);
    void session.callRemy();
  };
  // What to say to her, once she is on the call; not when the walkthrough runs the call.
  const tip = !rail ? <CallTip call={session} remyHere={snapshot.remy !== null && snapshot.remy !== 'joining'} /> : null;
  return (
    <>
      <CallEntry
        snapshot={snapshot}
        view={entryView}
        waiting={room?.people.length ?? 0}
        minutes={entryMinutes}
        notice={away ? awayNote(away) : null}
        onStart={() => void session.join({ remy: held === null })}
      />
      <RailCall
        call={call}
        hand={hand}
        you={{ name, color }}
        voice={false}
        notice={notice}
        captions={captions}
        people={
          inCall && people.length > 0 ? (
            <>
              <RemySeat seat={view.seat} held={view.held} onCall={callRemy} />
              <CallTiles session={session} people={snapshot.people} />
            </>
          ) : undefined
        }
        controls={
          inCall ? (
            <>
              {tip}
              <CallBarControls session={session} captions={captions} onCaptions={setCaptions} minutesTotalMs={minutes?.totalMs ?? null} />
            </>
          ) : undefined
        }
      />
      {inCall && captions && (
        <p className="visually-hidden" aria-live="polite" data-testid="call-captions-final">
          {finalLine && <span key={finalLine.n}>{finalLine.text}</span>}
        </p>
      )}
    </>
  );
}
