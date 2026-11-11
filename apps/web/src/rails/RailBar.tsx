/**
 * The walkthrough in the header: Previous, the counter with the step's name, and Next. Next is the one
 * thing a reviewer needs to press. Page Down and the right arrow press it too, and Page Up and the left
 * arrow press Previous, so one key or a clicker drives it while recording. Arrow keys inside the chart
 * stay the chart's.
 */
import { motion, type MotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { drumStyle, useDrum, useFace, type DrumShape } from '../onboarding/StoryDrum';
import type { RailRunner, RailState } from './runner';
import '../styles/onboarding.css';
import '../styles/rails.css';

export function useRailState(runner: RailRunner): RailState {
  return useSyncExternalStore(
    (listener) => runner.subscribe(listener),
    () => runner.state,
  );
}

const COUNTER: DrumShape = { rowHeight: 20, degrees: 50 };

function Face({ turn, index, children }: { turn: MotionValue<number>; index: number; children: ReactNode }) {
  const style = useFace(turn, index, COUNTER);
  return (
    <motion.span className="story-face" style={style}>
      {children}
    </motion.span>
  );
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || Boolean(target.closest('[contenteditable="true"], .b-editor')));

export function RailBar({ runner }: { runner: RailRunner }) {
  const state = useRailState(runner);
  const count = runner.steps.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTyping(event.target)) return;
      const inChart = event.target instanceof HTMLElement && Boolean(event.target.closest('.b-grid, .b-gantt'));
      const forward = event.key === 'PageDown' || (event.key === 'ArrowRight' && !inChart);
      const back = event.key === 'PageUp' || (event.key === 'ArrowLeft' && !inChart);
      if (!forward && !back) return;
      event.preventDefault();
      event.stopPropagation();
      void (forward ? runner.next() : runner.previous());
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [runner]);

  // Row 0 of the drum is "Start here"; row n is step n.
  const at = state.index + 1;
  const { turn, first, last } = useDrum(at);
  const rows = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  const nameOf = (row: number) => (row === 0 ? 'Start here' : (runner.steps[row - 1]?.label ?? ''));

  // The name's window follows the name, so the wheel never clips it.
  const sizer = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState<number>();
  useLayoutEffect(() => {
    const node = sizer.current;
    if (!node) return undefined;
    const measure = () => setLabelWidth(Math.ceil(node.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const running = state.status === 'running';
  const finished = state.index === count - 1 && state.status === 'done';
  const failed = state.status === 'failed';

  return (
    <div className={`rail-bar is-${state.status}`} data-testid="rail-bar" data-step={state.index} data-status={state.status}>
      <button type="button" className="rail-bar-back" aria-label="Previous step" title="Previous (Page Up)" disabled={state.index < 0} onClick={() => void runner.previous()} data-testid="rail-previous">
        <i className="fa fa-chevron-left" aria-hidden="true" />
      </button>
      <span className="rail-bar-counter" aria-live="polite" aria-label={at === 0 ? 'Start here' : `Step ${at} of ${count}: ${nameOf(at)}`}>
        {at > 0 && (
          <span className="rail-bar-count">
            <span className="story-wheel rail-bar-digit" style={{ ...drumStyle(COUNTER), width: `${String(at).length}ch` }}>
              {rows.map((row) => (
                <Face key={row} turn={turn} index={row}>
                  {row === 0 ? '' : row}
                </Face>
              ))}
            </span>
            <span className="rail-bar-of">/{count}</span>
          </span>
        )}
        <span className="story-wheel rail-bar-label" style={{ ...drumStyle(COUNTER), width: labelWidth }}>
          <span className="rail-bar-sizer" ref={sizer}>
            {nameOf(at)}
          </span>
          {rows.map((row) => (
            <Face key={row} turn={turn} index={row}>
              {nameOf(row)}
            </Face>
          ))}
        </span>
        {failed && <i className="fa fa-triangle-exclamation rail-bar-warn" title={state.error ?? 'This step did not finish'} aria-label="This step did not finish" />}
      </span>
      <button
        type="button"
        className="button is-primary is-sm rail-bar-next"
        disabled={running || finished}
        title={failed ? (state.error ?? undefined) : 'Next (Page Down)'}
        onClick={() => void runner.next()}
        data-testid="rail-next"
      >
        {running && <i className="fa fa-spinner fa-spin" aria-hidden="true" />}
        {failed ? 'Try again' : 'Next'}
        {!running && !failed && <i className="fa fa-chevron-right" aria-hidden="true" />}
      </button>
    </div>
  );
}
