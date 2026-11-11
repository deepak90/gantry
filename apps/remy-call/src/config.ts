/**
 * Remy's call worker in one place: who she is, which models she uses, and the timings of her
 * turn-taking. The numbers were tuned on recorded test calls with three callers; the comments say why.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FryOptions } from './fry.ts';

/** Explicit dispatch only: the room's first token asks for this agent. Overridable for isolated test runs. */
export const AGENT_NAME = process.env.REMY_AGENT_NAME?.trim() || 'remy';
export const IDENTITY = 'remy';
export const DISPLAY_NAME = 'Remy';

/**
 * Ears: OpenAI realtime transcription, one session per person. `REMY_STT_MODEL` picks another: with
 * `gpt-live-transcribe` the words come while the person is still talking (the call's captions are live), where
 * `gpt-4o-mini-transcribe` writes them once they stop.
 */
// gpt-live-transcribe streams words while a person talks, so the call bar captions them live (measured: first
// words at 1.1 s against 8.2 s for gpt-4o-mini-transcribe on a 7 s line, finals word for word, the same addressing).
export const STT_MODEL = process.env.REMY_STT_MODEL?.trim() || 'gpt-live-transcribe';
/** What the transcriber is told about the call; people's names and the plan's words are added per call. */
export const STT_SETTING = 'A construction work call with Remy, an AI assistant.';

/**
 * Mouth: one request per line, streamed. Her own ElevenLabs voice when `ELEVEN_LABS_VOICE_REMY_KEY` holds its id
 * (`ELEVEN_LABS_API_KEY` goes with it), otherwise OpenAI's below (elevenlabs.ts chooses). Flash v2.5 by default: on her
 * voice its first byte came in 162 ms back to back and about 250 ms with a call's gaps between lines, against 330 and
 * 440 ms for Multilingual v2, at half the credits (Turbo v2.5 lands between them and is deprecated). Whisper heard every
 * word and amount on each model, and pitch movement, bandwidth and pace showed no cost for the speed; ElevenLabs does
 * rate Multilingual v2 the more lifelike, so `REMY_ELEVEN_TTS_MODEL` swaps it in to compare by ear.
 */
export const ELEVEN_TTS_MODEL = process.env.REMY_ELEVEN_TTS_MODEL?.trim() || 'eleven_flash_v2_5';
export const TTS_MODEL = 'gpt-4o-mini-tts';
export const TTS_VOICE = 'marin';
/**
 * How she sounds. The wording barely moves her timing; this one gives the fewest pauses inside sentences and never
 * drops words (telling her to run openers into the next words can drop a whole sentence).
 */
export const TTS_INSTRUCTIONS =
  'A calm, friendly site-office colleague talking with the team on a work call. Relaxed and conversational, at a normal talking pace, with the words flowing together and no dramatic pauses.';
/** Sound held before a line starts playing, so it never runs dry mid-word (jitter-buffer.ts). */
export const PREROLL_MS = 400;
/**
 * Pace check (pace.ts), for OpenAI's voice (`checksPace` in elevenlabs.ts says why not hers). The voice model varies its delivery per request, and now and then reads a line slow and flat.
 * Measured as kept ms of sound per spoken syllable (spoken.ts), her normal lines run 212 to 288 and a dragging one
 * about 333. One retry usually brings back her normal pace, so each line is rendered whole before it plays, and a take
 * slower than the limit is asked for once more; the faster take plays. The cost is that wait: a line starts once all
 * of it is in (up to 1.7 s later on her longest lines, about nothing on short ones), plus a second render when a take
 * is retried. `REMY_PACE_CHECK=off` turns it off; the preroll, pause shortening and trimming stay as they are.
 */
export const PACE_CHECK_ON = process.env.REMY_PACE_CHECK?.trim().toLowerCase() !== 'off';
/** A take slower than this many ms per spoken syllable is asked for again. */
export const PACE_LIMIT_MS = 300;
/** Lines under this many syllables aren't checked: one pause skews them ("On it." ran 330, 660 ms for 2). */
export const PACE_MIN_SYLLABLES = 4;
/** A retry faster than this has likely lost words, and never plays (her quickest lines run about 210). */
export const PACE_FLOOR_MS = 150;
/**
 * Fry check (fry.ts), part of the pace check: a take that drops into a low, creaky register is asked for again too.
 * A render can fall about an octave on a few words, in a voice otherwise at 150–300 Hz, and sound like a different
 * voice, at a normal pace. In a line with fry, 18.6% of the voiced 20 ms windows sat under 133 Hz (0.7 of its 190 Hz
 * median), the longest stretch 300 ms; lines without it had at most 7.4%, and at most 140 ms. The last
 * 300 ms of a line's voicing isn't judged: her last syllable often ends in a creak of its own (60–125 Hz) that sounds
 * natural. Of the two takes, the one without fry plays, then the faster. `REMY_FRY_CHECK=off` leaves fry unchecked.
 */
export const FRY_CHECK_ON = process.env.REMY_FRY_CHECK?.trim().toLowerCase() !== 'off';
/** Low: under 135 Hz and under 0.7 of the line's median. Fry: 160 ms of low in a row, or over 10% of voiced windows low. */
export const FRY: FryOptions = { floorHz: 135, ratio: 0.7, minRunMs: 160, maxShare: 0.1, skipEndMs: 300 };

/** Silero's end-of-speech wait. At its default 550 ms, Remy's first sound once came only 350 ms inside the 2.5 s goal. */
export const END_OF_SPEECH_MS = 400;
/** A turn is handed over this long after the speech ended, once its last transcript is in. */
export const TURN_HOLD_MS = 250;
/** ...or this long after the speech ended, transcript or not. */
export const TURN_SAFETY_MS = 2000;
/** A line to Remy that sounds unfinished ("Remy, you on?", "Remy, can you—") waits this long after the speech for more. */
export const TURN_CONTINUE_MS = 1200;

/** A person's next turn this soon after Remy answered them (or after a bare "Remy?") is for Remy. */
export const FOLLOW_UP_MS = 8000;
/**
 * Alone with Remy (one person on the call), every line is for her, all but a plain "okay" or "thanks". That is for her
 * too when her answer asked them something, this long after: alone, people read the card before they say "yes".
 */
export const ALONE_ANSWER_MS = 30_000;

/** Say a filler when no line has come this long after an addressed line ended. */
export const FILLER_AFTER_MS = 1200;
/** ...but never sooner than this after the line was heard, so a reply that is already on its way wins. */
export const FILLER_GRACE_MS = 250;
/** When someone is talking at that moment, try again until this much later, then give up. */
export const FILLER_GIVE_UP_MS = 1500;
/**
 * Said in one breath, spread out (filler.ts picks one she hasn't said lately, never the last one again): mostly what she
 * is doing, in a few words. Each passes the check below before it is used. "One sec." tends to draw out into two beats,
 * and the "Mm" of "Mm, let me look." is always a beat of its own.
 */
export const FILLERS = ['Let me look.', 'Pulling it up.', 'One moment.', 'Looking into it.', 'Let me see.', 'Checking the plan.', 'Give me a second.', 'Looking it up.'] as const;
/** A filler take is refused when two of its words sit further apart than this (filler-audio.ts)... */
export const FILLER_MAX_GAP_MS = 250;
/** ...or when it is drawn out: slower than this many syllables a second. */
export const FILLER_MIN_SYLLABLES_PER_SEC = 3;
/** Takes made of a filler before it is given up (it is then never said). */
export const FILLER_ATTEMPTS = 4;
/** Where fillers that passed are kept between calls: `REMY_FILLER_CACHE`, else the OS temp folder. */
export const FILLER_CACHE_DIR = process.env.REMY_FILLER_CACHE?.trim() || join(tmpdir(), 'remy-call', 'fillers');
/** `REMY_FILLERS=off`: no fillers at all; her words are only the answers she is handed. */
export const FILLERS_ON = process.env.REMY_FILLERS?.trim().toLowerCase() !== 'off';

/** An addressed line nobody answered stops counting as "Remy is thinking" after this. */
export const PENDING_TTL_MS = 45_000;
/** A line waits at most this long for whoever is talking to pause. */
export const FLOOR_WAIT_MAX_MS = 2000;
/** The longest line on a local run; the hosted worker takes 400 (line-limits.ts). */
export const SAY_MAX_CHARS = 4000;
/**
 * The secret the assistant service signs Remy's replies with (line-proof.ts). With it, she says only lines the service
 * wrote; the hosted worker has it as a LiveKit secret. Without it (a local run), she says what the host hands her.
 */
export const LINE_SECRET = process.env.REMY_LINE_SECRET?.trim() || null;
/** Said once, when a hosted call's answers have used up their characters (line-limits.ts). */
export const BUDGET_SPENT_LINE = 'I’ve hit my talking limit for this call. My answers are still in the chat.';

/** Said 30 seconds before a call's time runs out (limits.ts: hosted calls only, unless REMY_CALL_MAX_S is set). */
export const WRAP_UP_LINE = 'Heads up, I have to drop off in thirty seconds.';
/** Said when nobody has spoken for the silence limit, before she leaves (REMY_SILENCE_S). */
export const GOODBYE_LINE = "It's gone quiet, so I'll drop off. Call me back anytime.";
/** The goodbye gets this long to play before she leaves anyway. */
export const GOODBYE_MAX_MS = 10_000;

/**
 * Leave once the last person has been gone this long. On the hosted worker (`GANTRY_HOSTED=1`) she waits a minute, so
 * someone who hangs up and calls back finds her still on the same call, with its time left, and nobody is sent again:
 * a new Remy sent within seconds of the last one leaving can be ended by LiveKit at once. The call's own
 * limits still end it: the silence limit counts while she waits.
 */
export const EMPTY_ROOM_LEAVE_MS = process.env.GANTRY_HOSTED?.trim() === '1' ? 60_000 : 5000;
/** Leave a room nobody joins. */
export const NOBODY_CAME_LEAVE_MS = 20_000;
/** Keep a leaving person's transcriber this long, so their last words still arrive. */
export const LEAVE_GRACE_MS = 3000;
/** How long Remy waits for the call server to take her `remy.leaving` attribute before she leaves anyway. */
export const LEAVING_MARK_MS = 1000;
