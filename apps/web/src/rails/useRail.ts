/**
 * The walkthrough on a page: the assistant's hand, the call, and the runner that plays the script one
 * step per press of Next. Every step goes the same way: your line first (sent to the assistant when the
 * step says so), then the step itself, then its takeaway once everyone has stopped talking.
 *
 * The voice mode (the dev server only, with `?voice` in the address) listens between presses: what you
 * say is transcribed as you say it, and the line as heard is what the step works with and what reaches
 * the thread, marked as said aloud. Built for production, the voice mode's code is left out.
 */
import { mirrorCall } from '../assistant/attention';
import { useEffect, useState, type MutableRefObject } from 'react';
import { Call } from './call';
import { Hand } from './hand';
import { RailRunner } from './runner';
import type { RailApp, RailContext, RailScript, RailStep } from './types';
import { waitFor } from './wait';

export interface Rail {
  hand: Hand;
  runner: RailRunner;
  call: Call;
  /** Whether the voice mode is on: your microphone shows on the call. */
  voice: boolean;
}

/** Which voice the address asks for: `?voice` is your microphone, `?voice=fake` a made-up one. */
export function voiceAsked(search: string): 'mic' | 'fake' | null {
  const params = new URLSearchParams(search);
  if (!params.has('voice')) return null;
  return params.get('voice') === 'fake' ? 'fake' : 'mic';
}

/** What the step wrapper needs from the voice mode: your line, as heard. */
export interface HeardLine {
  take(): Promise<string>;
}

/**
 * Your line, then the step, then its takeaway. In the voice mode your line is what was heard, shown and
 * sent as it was heard; if nothing was, the step doesn't run, and you say it again. Otherwise it is the
 * printed line, brought up at a reading pace.
 */
export function asSpoken(step: RailStep, voiceOf: () => HeardLine | null): RailStep {
  return {
    ...step,
    async run(context) {
      const { call, signal, app } = context;
      let said = step.you?.text ?? '';
      if (step.you) {
        const voice = voiceOf();
        if (voice) {
          said = (await voice.take()).trim();
          if (!said) {
            call.set({ words: null, takeaway: { lead: 'Nothing was heard.', text: 'Say your line again, then press Next.' } });
            throw new Error('Nothing was heard. Say your line again, then press Next.');
          }
          await call.hear(said, signal, { reveal: false });
        } else await call.hear(said, signal);
        if (step.you.ask) await app.send(said, voice ? 'voice' : 'text');
      }
      call.doing('working');
      await step.run({ ...context, said });
      // Out of the way until the next step needs it.
      void context.hand?.rest?.();
      await call.quiet();
      call.doing('idle');
      // A step with no takeaway (the film's take: the call is the captions) leaves the words alone.
      if (step.caption.lead) call.settle(step.caption);
    },
  };
}

export function useRail(script: RailScript | null, app: MutableRefObject<RailApp | null>): Rail | null {
  const [rail, setRail] = useState<Rail | null>(null);

  useEffect(() => {
    if (!script) return undefined;
    const { name } = script.assistant;
    const hand = new Hand({ name });
    const call = new Call({ name });
    // Where the assistant is, for its face over the 3D view: its mood, its voice and its cursor.
    const stopAttention = mirrorCall(call, hand);
    const voiceKind = import.meta.env.DEV ? voiceAsked(window.location.search) : null;
    let voice: { listener: { listen(expected: string): void; stop(): void; take(): Promise<string> }; close(): void } | null = null;
    let closed = false;

    const runner = new RailRunner(
      script.steps.map((step) => asSpoken(step, () => (voice ? { take: () => voice!.listener.take() } : null))),
      {
        makeContext: (signal): RailContext => ({
          hand,
          call,
          signal,
          said: '',
          app: app.current!,
          wait: (probe, options) => waitFor(probe, { ...options, signal }),
          pause: (ms) => hand.beat(ms, signal),
          say: (text) => call.say(text, signal),
          think: (work) => call.think(work),
          join: async () => {
            await Promise.all([hand.join(undefined, signal), call.join(signal)]);
          },
          leave: async () => {
            await Promise.all([hand.leave(signal), call.leave(signal)]);
          },
        }),
      },
    );

    // Between presses, the voice mode waits for the next step's line.
    const listenForNext = () => {
      if (!voice) return;
      const { index, status } = runner.state;
      const next = status === 'running' ? null : runner.steps[status === 'failed' ? index : index + 1];
      if (next?.you) voice.listener.listen(next.you.text);
      else voice.listener.stop();
    };

    let lastIndex = runner.state.index;
    // Played by a call: each step follows the one before; one that fails is left, and the next goes on.
    const stopAuto = script.auto
      ? runner.subscribe((state) => {
          if (state.status === 'failed') {
            console.warn(`Take step "${runner.steps[state.index]?.key}" failed: ${state.error}`);
            queueMicrotask(() => {
              runner.skip();
              void runner.next();
            });
          } else if (state.status === 'done' && state.index >= 0 && state.index < runner.steps.length - 1) queueMicrotask(() => void runner.next());
        })
      : () => undefined;
    const unsubscribe = runner.subscribe((state) => {
      // Back to the start: the assistant is gone, as before it joined. Back a step: the words go.
      if (state.index < 0 && state.status === 'ready') {
        hand.reset();
        call.reset();
      } else if (state.index < lastIndex) call.clearWords();
      lastIndex = state.index;
      listenForNext();
    });

    if (import.meta.env.DEV && voiceKind) {
      void import('./voice')
        .then(({ startVoice }) => startVoice(call, voiceKind))
        .then((started) => {
          if (closed) started.close();
          else {
            voice = started;
            listenForNext();
          }
        })
        .catch((error: unknown) => console.warn('The voice mode has no microphone', error));
    }

    // Dev only: `?railfrom=<step key>` stands the walkthrough just before that step, with the assistant already on the call.
    const from = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('railfrom') : null;
    const fromIndex = from ? runner.steps.findIndex((step) => step.key === from) : -1;
    if (fromIndex > 0) {
      runner.startAt(fromIndex);
      const joining = new AbortController();
      void Promise.all([hand.join(undefined, joining.signal), call.join(joining.signal)]).catch(() => undefined);
    }

    setRail({ hand, runner, call, voice: Boolean(voiceKind) });
    return () => {
      closed = true;
      stopAuto();
      unsubscribe();
      stopAttention();
      // Teammates it brought in leave with it.
      app.current?.team?.stop();
      runner.dispose();
      hand.destroy();
      voice?.close();
      call.reset();
      setRail(null);
    };
  }, [script, app]);

  return rail;
}
