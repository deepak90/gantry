/**
 * "One payment, start to finish": Gantry drawn in code, playing the film's last scene once (landing.html,
 * `[data-scene]`), the first time it's on screen.
 *
 * The footings payment holds the slab; Chris asks what waiting till Friday would do, and the slab's work slides
 * past the inspector's week away (the handover goes from May 27 to June 8); Deepak says to pay now, the hold turns
 * Paid, and the work comes back. The lines are the film's own words (the film at 1:37, linked under the drawing).
 *
 * It plays once, about 15 seconds, then holds its last frame, with Pause, Play and Replay under it. It waits while
 * it's off screen. Under reduced motion it opens on the last frame and plays only when asked, without moving.
 */
import { onReducedMotionChange, prefersReducedMotion, Timeline, watchVisibility, type Step } from './motion';

type Speaker = 'remy' | 'deepak' | 'chris';

const NAMES: Record<Speaker, string> = { remy: 'Remy', deepak: 'Deepak', chris: 'Chris' };

/** What's said, as the film's captions have it (an ellipsis where words are left out of the middle of a line). */
export const SCENE_LINES = {
  ask: ['deepak', 'Remy, what’s holding the ground floor?'],
  hold: ['remy', 'The footings payment, $37,800.'],
  friday: ['chris', 'Remy, what happens if we wait till Friday?'],
  forecast: ['remy', 'We’d miss the city inspector … and the handover moves 12 days to June 8th.'],
  pay: ['deepak', 'Well, they did the work. Remy, let’s pay them now.'],
  paid: ['remy', 'Both payments went through, so the ground floor can start tomorrow.'],
} as const satisfies Record<string, readonly [Speaker, string]>;

/** The states the drawing passes through, as classes on `.app` (landing.css draws each). */
const STATES = ['is-held', 'is-forecast', 'is-paying', 'is-processing', 'is-paid'] as const;

export function startScene(root: ParentNode = document): void {
  const stage = root.querySelector<HTMLElement>('[data-scene]');
  const app = stage?.querySelector<HTMLElement>('[data-scene-app]');
  const call = app?.querySelector<HTMLElement>('.call');
  const who = app?.querySelector<HTMLElement>('[data-call-who]');
  const said = app?.querySelector<HTMLElement>('[data-call-said]');
  const control = stage?.querySelector<HTMLButtonElement>('[data-scene-control]');
  if (!stage || !app || !call || !who || !said || !control) return;

  const say = ([speaker, text]: readonly [Speaker, string] | readonly ['', '']) => {
    call.dataset.speaking = speaker;
    who.textContent = speaker ? NAMES[speaker] : '';
    said.replaceChildren(
      ...text.split(' ').map((word, index) => {
        const span = document.createElement('span');
        span.className = 'w';
        span.style.setProperty('--w', String(index));
        span.textContent = `${word} `;
        return span;
      }),
    );
  };
  const set = (...on: (typeof STATES)[number][]) => {
    for (const state of STATES) app.classList.toggle(state, on.includes(state));
  };
  const start = () => {
    // Snap back without animating, then let the first frame paint.
    app.classList.add('is-resetting');
    set();
    say(['', '']);
    void app.offsetWidth;
    app.classList.remove('is-resetting');
  };
  const end = () => {
    set('is-paid');
    say(SCENE_LINES.paid);
  };

  const steps: Step[] = [
    [0, start],
    [700, () => say(SCENE_LINES.ask)],
    [2700, () => {
      say(SCENE_LINES.hold);
      set('is-held');
    }],
    [4800, () => say(SCENE_LINES.friday)],
    [6800, () => {
      say(SCENE_LINES.forecast);
      set('is-held', 'is-forecast');
    }],
    [10600, () => say(SCENE_LINES.pay)],
    [12500, () => set('is-held', 'is-forecast', 'is-paying')],
    [13200, () => set('is-held', 'is-forecast', 'is-processing')],
    [13900, () => set('is-paid')],
    [14500, () => say(SCENE_LINES.paid)],
    [17500, () => {}],
  ];

  let userPaused = false;
  const show = (label: 'Pause' | 'Play' | 'Replay' | 'Play the scene') => {
    control.hidden = false;
    control.textContent = label;
  };
  const timeline = new Timeline(steps, app, () => show(prefersReducedMotion() ? 'Play the scene' : 'Replay'));

  control.addEventListener('click', () => {
    if (timeline.playing) {
      userPaused = true;
      timeline.pause();
      show('Play');
    } else if (timeline.finished || control.textContent === 'Play the scene') {
      userPaused = false;
      timeline.rewind();
      timeline.play();
      show('Pause');
    } else {
      userPaused = false;
      timeline.play();
      show('Pause');
    }
  });

  let started = false;
  if (prefersReducedMotion()) {
    started = true;
    end();
    show('Play the scene');
  }

  // It starts the first time it's well on screen; off screen it waits, and back on screen it carries on (unless
  // someone pressed Pause).
  watchVisibility(stage, (fraction) => {
    if (!started) {
      if (fraction < 0.4) return;
      started = true;
      timeline.play();
      show('Pause');
      return;
    }
    if (fraction < 0.2 && timeline.playing) timeline.pause();
    else if (fraction >= 0.35 && !timeline.playing && !timeline.finished && !userPaused && control.textContent === 'Pause') timeline.play();
  }, [0, 0.2, 0.35, 0.4, 0.6]);

  onReducedMotionChange((reduce) => {
    if (!reduce) return;
    timeline.rewind();
    end();
    show('Play the scene');
  });
}
