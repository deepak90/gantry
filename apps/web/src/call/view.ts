/**
 * The call as the screen shows it, worked out from who is in it: one tile per person (initials in their
 * cursor color, a ring while they speak, a mute badge, "AI voice" on simulated people), who hosts the
 * call, what the header offers before the call, and Remy's seat on the call bar while she isn't on it.
 * Plain functions over plain data; the call session feeds them.
 */
import { initialsOf, readableInkOn } from '../presence/peers';
import { ASSISTANT_NAME } from '../assistant/identity';
import type { CallHold, RoomBlock } from './hold';
import type { RoomMinutes } from './minutes';
import { REMY } from './protocol';

/** Someone in the room, as the call session reads them from LiveKit. */
export interface CallPerson {
  identity: string;
  name: string;
  /** Their cursor color. */
  color: string;
  role: string | null;
  /** A simulated person: an AI voice. */
  sim: boolean;
  isRemy: boolean;
  /** This tab's own person. */
  isLocal: boolean;
  /** The server hears them speaking. */
  speaking: boolean;
  micOn: boolean;
  /** When they joined, in ms since the epoch; 0 when it isn't known. */
  joinedAt: number;
}

/** A participant as LiveKit has it, reduced to what the call reads. */
export interface RawParticipant {
  identity: string;
  name?: string | undefined;
  attributes: Readonly<Record<string, string>>;
  isAgent: boolean;
  isLocal: boolean;
  isSpeaking: boolean;
  micOn: boolean;
  joinedAt: number;
}

const COLOR = /^#[0-9a-f]{6}$/i;
/** Who has no color of their own (never red: red means danger here). */
const NO_COLOR = '#46576c';

export function personFrom(raw: RawParticipant): CallPerson {
  const isRemy = raw.identity === REMY || raw.isAgent;
  const color = raw.attributes.color && COLOR.test(raw.attributes.color) ? raw.attributes.color : NO_COLOR;
  return {
    identity: raw.identity,
    name: raw.attributes.name?.trim() || raw.name?.trim() || (isRemy ? 'Remy' : 'Someone'),
    color,
    role: raw.attributes.role?.trim() || null,
    sim: raw.attributes.sim === 'true',
    isRemy,
    isLocal: raw.isLocal,
    speaking: raw.isSpeaking,
    micOn: raw.micOn,
    joinedAt: raw.joinedAt,
  };
}

/** A recording participant (`recorder-…`): in the room, never on screen. */
export const isRecorder = (identity: string): boolean => identity.startsWith('recorder-');

/** The people on the call, without Remy or a recorder. */
export const humansOf = (people: readonly CallPerson[]): CallPerson[] => people.filter((person) => !person.isRemy && !isRecorder(person.identity));

export const remyOf = (people: readonly CallPerson[]): CallPerson | null => people.find((person) => person.isRemy) ?? null;

/** Oldest first; whoever's join time isn't known goes last; then by identity, so every tab agrees. */
const byJoining = (a: CallPerson, b: CallPerson): number => (a.joinedAt || Infinity) - (b.joinedAt || Infinity) || a.identity.localeCompare(b.identity);

/**
 * Who hosts the call: the person who has been on it longest, so the first to start it. Every tab works
 * it out the same way, so there is one host; if the host leaves, the next longest takes over.
 */
export function hostOf(people: readonly CallPerson[]): string | null {
  return humansOf(people).sort(byJoining)[0]?.identity ?? null;
}

/** The name without the simulated mark the app adds to it ("Tom Becker (sim)"). */
const bareName = (name: string): string => name.replace(/\s*\(sim\)\s*$/i, '').trim() || name;

export const firstNameOf = (name: string): string => bareName(name).split(/\s+/)[0] || name;

export interface Tile {
  identity: string;
  initials: string;
  /** Under the face: everyone's first name, this tab's person too (a recording of the call shows who is who). */
  label: string;
  /** Said in full for the tooltip and screen readers. */
  title: string;
  color: string;
  /** The text color that reads on `color`. */
  ink: string;
  speaking: boolean;
  muted: boolean;
  /** "AI voice" on a simulated person. */
  tag: 'AI voice' | null;
  isLocal: boolean;
}

/** One tile per person on the call, in the order they joined. Remy has her own tile, the call face. */
export function tilesOf(people: readonly CallPerson[]): Tile[] {
  return humansOf(people)
    .sort(byJoining)
    .map((person) => {
      const name = bareName(person.name);
      const muted = !person.micOn;
      return {
        identity: person.identity,
        initials: initialsOf(name),
        label: firstNameOf(name),
        title: [person.isLocal ? `${name} (you)` : name, person.sim ? 'AI voice' : null, muted ? 'muted' : null].filter(Boolean).join(', '),
        color: person.color,
        ink: readableInkOn(person.color),
        speaking: person.speaking,
        muted,
        tag: person.sim ? 'AI voice' : null,
        isLocal: person.isLocal,
      };
    });
}

export type CallStatus = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'failed';

/** What the dev server says about the project's room before this tab is in it. */
export interface RoomNews {
  /** The call server answered. */
  up: boolean;
  /** The names of the people on the call now. */
  people: readonly string[];
  remy: boolean;
  /** The session's minutes with Remy, where the site keeps them (hosted). */
  minutes?: RoomMinutes | null;
  /** Why a call can't be had now, before anyone presses (hosted). */
  blocked?: RoomBlock | null;
}

export interface StripView {
  /** Before the call, in the header: start one, or join the one that's going. */
  start: { label: 'Call Remy' | 'Join'; title: string } | null;
  joining: boolean;
  inCall: boolean;
  /** On the call, and Remy hasn't come: offer to call her in. */
  callRemy: boolean;
  /**
   * Her seat on the call bar while she isn't on the call: `joining` while she is on her way (sent with the call,
   * or just called in), `offer` once she is late (or the call started without her), `held` while the server has
   * said she can't come (hold.ts), null while she is on it.
   */
  seat: 'joining' | 'offer' | 'held' | null;
  /** One short line about the call, with more in its title. */
  note: { text: string; title: string } | null;
  /** The server said Remy can't be brought in, for now: what the button says instead, and why. */
  held: { text: string; title: string } | null;
}

const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * What the call offers. Before the call, in the header: "Call Remy", or "Join" when someone is on it; while
 * joining, "Joining…". On it, the call bar has the microphone, captions and "Leave", and Remy's seat: "Remy is
 * joining…" while she is on her way, then "Call Remy" if she isn't there a while after. `hosted`: the hosted site,
 * whose call server isn't on this machine.
 */
export function stripOf({
  status,
  error,
  room,
  remyHere,
  remyLate,
  hosted = false,
  hold = null,
}: {
  status: CallStatus;
  error: string | null;
  room: RoomNews | null;
  remyHere: boolean;
  remyLate: boolean;
  hosted?: boolean;
  /** The server's last "she can't come" (hold.ts), while it holds. */
  hold?: CallHold | null;
}): StripView {
  const held = hold ? { text: hold.text, title: hold.title } : null;
  if (status === 'joining') return { start: null, joining: true, inCall: false, callRemy: false, seat: null, note: null, held: null };
  if (status === 'connected' || status === 'reconnecting') {
    const seat = remyHere ? null : held ? 'held' : remyLate ? 'offer' : 'joining';
    return {
      start: null,
      joining: false,
      inCall: true,
      callRemy: seat === 'offer',
      seat,
      note: status === 'reconnecting' ? { text: 'Reconnecting…', title: 'The call dropped for a moment; it is coming back.' } : null,
      held: seat === 'held' ? held : null,
    };
  }
  const going = room ? [...room.people, ...(room.remy ? ['Remy'] : [])] : [];
  const start =
    room && room.people.length > 0
      ? { label: 'Join' as const, title: `${listed(going)} ${going.length === 1 ? 'is' : 'are'} on the call` }
      : { label: 'Call Remy' as const, title: 'Start a call with Remy. Everyone in this project can join.' };
  const off = hosted
    ? { text: 'Calls unavailable', title: 'The call server isn’t answering right now. The plan and the chat still work.' }
    : { text: 'Call server off', title: 'The call server is not running on this machine (livekit-server --dev).' };
  // The session's minutes with her are used up: there is no call to start or join, and the header says so instead.
  if (hold?.code === 'minutes_spent') return { start: null, joining: false, inCall: false, callRemy: false, seat: null, note: null, held };
  // Held: with people on a call, they can still be joined (without her), and a line says why she isn't coming;
  // with nobody on one, the button itself says she is unavailable, and nothing else needs saying.
  if (held) {
    const going = room !== null && room.people.length > 0;
    return { start, joining: false, inCall: false, callRemy: false, seat: null, note: going ? { text: `${ASSISTANT_NAME} unavailable`, title: held.title } : null, held: going ? null : held };
  }
  const note = status === 'failed' ? { text: 'Call unavailable', title: error ?? 'The call could not start.' } : room && !room.up ? off : null;
  return { start, joining: false, inCall: false, callRemy: false, seat: null, note, held: null };
}
