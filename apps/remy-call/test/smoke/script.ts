/**
 * The smoke call's cast, lines and Remy's replies. Clips made earlier can be reused with
 * `--clips <dir>` (one `<id>.wav` per line); missing ones are made with gpt-4o-mini-tts and
 * cached. `addressed` is what Remy's rule must decide.
 */
export type Who = 'deepak' | 'nora' | 'tony';

export const CAST: Record<Who, { name: string; role: string; color: string; voice: string; instructions: string }> = {
  deepak: {
    name: 'Deepak Jayaram',
    role: 'cm',
    color: '#d97706',
    voice: 'ash',
    instructions:
      'A construction cost manager on a work call, quick and direct. Natural conversational speech, not a read. Say every um, uh and cut-off restart exactly as written; a dash is a self-interruption.',
  },
  nora: {
    name: 'Nora Bennett',
    role: 'pm',
    color: '#2563eb',
    voice: 'coral',
    instructions:
      'A construction project manager on a work call, mid-thirties, warm and brisk. Natural conversational speech, not a read. Say every um, uh and cut-off restart exactly as written; a dash is a self-interruption.',
  },
  tony: {
    name: 'Tony (Granite Ridge)',
    role: 'sub',
    color: '#16a34a',
    voice: 'onyx',
    instructions:
      'A concrete subcontractor foreman on a work call, fifties, relaxed and plain-spoken. Natural conversational speech, not a read. Say every um, uh and cut-off restart exactly as written; a dash is a self-interruption.',
  },
};

export interface Line {
  who: Who;
  say: string;
  addressed: boolean;
  /** A hum while Remy talks: must not stop Remy. */
  hum?: boolean;
  instructions?: string;
}

export const LINES: Record<string, Line> = {
  d1: { who: 'deepak', addressed: true, say: "Remy, you on? Okay. So, um— I was out all last week. What'd I miss that actually costs us money?" },
  n1: {
    who: 'nora',
    addressed: false,
    hum: true,
    say: 'Mm-hm.',
    instructions:
      'A short, quiet, closed-mouth "mm-hm" of agreement while someone else is talking, hummed through the nose with the lips closed. Only the hum, no words.',
  },
  t1: { who: 'tony', addressed: false, say: 'Nora, uh, are we still pouring the slab on the twentieth? Or is that, uh, slipping?' },
  n2: { who: 'nora', addressed: false, say: "It's slipping. Remy's got it on hold till the, um, the footings get paid." },
  t2: { who: 'tony', addressed: true, say: 'Remy, when do we get paid for the footings?' },
  d2: { who: 'deepak', addressed: true, say: "Wait— wait, Remy, that's the slab. The footings are done already." },
  t3: { who: 'tony', addressed: false, say: 'Yeah, yeah— I can have the crew there Monday morning.' },
  // A follow-up without the name, right after Remy answered Deepak.
  f1: { who: 'deepak', addressed: true, say: 'Okay. And when does the crane get here?' },
};

/** What the host's tab hands Remy (stand-ins for Claude's replies). */
export const REPLIES = {
  a1: "Two things. The footings are done, but Granite Ridge's payment of thirty-seven thousand eight hundred dollars is on hold, and the slab waits behind it. And the crane is booked for the day before Thanksgiving, so it would sit idle over the long weekend.",
  a2: "Granite Ridge gets paid when the slab passes its inspection. That's planned for December fourth, and the payment goes out in the next batch after that, which is usually the following Friday.",
  a3: "You're right, sorry. The footings passed inspection last week. Their payment of thirty-seven thousand eight hundred dollars can go out today, and that releases the hold on the slab.",
  a4: 'Monday, November thirtieth, the Monday after Thanksgiving. Do you want me to move the slab pour to match?',
};
