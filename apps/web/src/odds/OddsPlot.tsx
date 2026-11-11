/**
 * The runs on screen, two ways: the 3D board (odds/odds-board.ts, the default) or the dot plot (odds/dot-plot.ts,
 * with a readout of the day under the pointer), switched by a quiet Board / Dots control. Both are handed to the
 * controller and told everything, so switching is instant. Over them, a line on what they are; under them, the legend,
 * the same counts as a table for whoever doesn't read the picture, and a line on what they say (odds/odds-explain.ts).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { dayWords, monthDay } from '../gantt/monte-carlo';
import { DotPlot, type PlotHover } from './dot-plot';
import { acquireBoardView, releaseBoardView, type BoardView, type BoardViewState, type ChartSide, type OddsView } from './odds-board';
import type { OddsController } from './odds-controller';

export interface OddsPlotProps {
  controller: OddsController;
  contractDay: number | null;
  /** Dots on screen, and how many of them hand over by the contract date. */
  shown: number;
  onTime: number;
  /** What the plot is showing, in words (a way forward), or null for the plan as it stands. */
  caption: string | null;
  onBackToNow(): void;
  /** The board or the dots. */
  view: OddsView;
  onView(view: OddsView): void;
  /** Where the board goes when it fills the chart's side (the Gantt's frame and its chart side). */
  chartSide?: () => ChartSide | null;
  /** Over the runs: what they are. */
  about?: ReactNode;
  /** Under them: what they say. */
  says?: ReactNode;
}

const NO_BOARD: BoardViewState = { failed: false, hero: false };
const noBoard = () => () => undefined;

const percentOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const percentWords = (value: number) => (value > 0 && value < 1 ? value.toFixed(1) : Math.round(value).toString());

export function OddsPlot({ controller, contractDay, shown, onTime, caption, onBackToNow, view, onView, chartSide, about, says }: OddsPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotRef = useRef<DotPlot | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [boardView, setBoardView] = useState<BoardView | null>(null);
  const [hover, setHover] = useState<PlotHover | null>(null);
  const [table, setTable] = useState<{ day: number; count: number }[] | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const chartSideRef = useRef(chartSide);
  chartSideRef.current = chartSide;

  // The board, attached before the panel asks for runs (child effects run first), so it is told every one of them.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    const board = acquireBoardView(controller, () => chartSideRef.current?.() ?? null);
    board.setShown(viewRef.current === 'board');
    board.mount(slot);
    const detach = controller.attachPlot(board.sink);
    setBoardView(board);
    return () => {
      detach();
      board.unmount(slot);
      releaseBoardView(board);
      setBoardView(null);
    };
  }, [controller]);
  const board = useSyncExternalStore(boardView?.subscribe ?? noBoard, boardView?.getState ?? (() => NO_BOARD));
  const hero = board.hero;
  // No board in this browser (no WebGL): the dots.
  const showing: OddsView = board.failed ? 'dots' : view;
  useEffect(() => {
    if (board.failed && view === 'board') onView('dots');
  }, [board.failed, view, onView]);
  useEffect(() => {
    boardView?.setShown(showing === 'board');
  }, [boardView, showing]);

  const choose = (next: OddsView) => {
    if (next === 'dots') boardView?.setHero(false);
    onView(next);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const plot = new DotPlot(canvas, setHover);
    plotRef.current = plot;
    const detach = controller.attachPlot({
      begin: (pass) => plot.begin(pass),
      land: (landed) => plot.land(landed),
      end: (runs) => plot.end(runs),
      show: (runs, days, instant) => plot.show(runs, days, instant),
    });
    return () => {
      detach();
      plot.dispose();
      plotRef.current = null;
    };
  }, [controller]);

  // The table follows the dots while it is open.
  const tableOpen = table !== null;
  useEffect(() => {
    if (tableOpen) setTable(plotRef.current?.counts() ?? []);
  }, [tableOpen, shown, onTime]);

  const late = Math.max(0, shown - onTime);
  const contract = contractDay !== null ? dayWords(contractDay) : '';
  const contractShort = contractDay !== null ? monthDay(contractDay) : '';
  const label = shown > 0 ? `Handover day of each of ${shown.toLocaleString('en-US')} runs: ${onTime.toLocaleString('en-US')} by ${contract}, ${late.toLocaleString('en-US')} after.` : 'Handover day of each run, as the runs finish.';

  return (
    <figure className="odds-plot" data-testid="odds-plot" data-view={hero ? 'hero' : showing}>
      {about}
      <div className="odds-plot-bar">
        <div className="segmented odds-view-switch" role="group" aria-label="Show the odds as">
          <button type="button" aria-pressed={showing === 'board'} disabled={board.failed} title={board.failed ? 'The board needs WebGL, which this browser has turned off' : undefined} onClick={() => choose('board')} data-testid="odds-view-board">
            Board
          </button>
          <button type="button" aria-pressed={showing === 'dots'} onClick={() => choose('dots')} data-testid="odds-view-dots">
            Dots
          </button>
        </div>
        {showing === 'board' && !hero && chartSide && (
          <button type="button" className="button is-quiet is-sm is-icon" title="Over the chart" aria-label="Show the board over the chart" onClick={() => boardView?.setHero(true)} data-testid="odds-board-hero">
            <i className="fa fa-up-right-and-down-left-from-center" aria-hidden="true" />
          </button>
        )}
      </div>
      {caption && (
        <div className="odds-plot-caption">
          <span>
            <i className="fa fa-eye" aria-hidden="true" /> {caption}
          </span>
          <button type="button" className="button is-link is-sm" onClick={onBackToNow}>
            Back to now
          </button>
        </div>
      )}
      <div className="odds-board-frame" ref={slotRef} hidden={showing !== 'board' || hero} role="img" aria-label={label} data-testid="odds-board" />
      {showing === 'board' && hero && (
        <p className="odds-board-away">
          <span>The board is over the chart.</span>
          <button type="button" className="button is-link is-sm" onClick={() => boardView?.setHero(false)}>
            Back to the panel
          </button>
        </p>
      )}
      <div className="odds-plot-frame" hidden={showing !== 'dots'}>
        <canvas ref={canvasRef} className="odds-plot-canvas" tabIndex={0} role="img" aria-label={label} />
        {hover && (
          <div className="odds-plot-readout" style={{ left: `${hover.x}px` }} role="status">
            <strong className="num">{dayWords(hover.day)}</strong>
            <span>
              {hover.count === 0 ? 'No runs hand over this day' : `${hover.count.toLocaleString('en-US')} ${hover.count === 1 ? 'run' : 'runs'} (${percentWords(percentOf(hover.count, hover.total))}%)`}
            </span>
            <span className="odds-plot-readout-soft">{`By the end of it: ${percentWords(percentOf(hover.byThen, hover.total))}%`}</span>
          </div>
        )}
      </div>
      <figcaption className="odds-plot-legend">
        <span>
          <i className="odds-swatch is-on-time" aria-hidden="true" /> By {contractShort}: <strong className="num">{onTime.toLocaleString('en-US')}</strong>
        </span>
        <span>
          <i className="odds-swatch is-late" aria-hidden="true" /> After: <strong className="num">{late.toLocaleString('en-US')}</strong>
        </span>
        {showing === 'dots' && (
          <span className="odds-plot-legend-note">
            <i className="odds-swatch is-closed" aria-hidden="true" /> No handover (weekend or holiday)
          </span>
        )}
        <button
          type="button"
          className="button is-link is-sm odds-plot-table-toggle"
          aria-expanded={table !== null}
          onClick={() => setTable((current) => (current ? null : (plotRef.current?.counts() ?? [])))}
        >
          {table ? 'Hide the table' : 'As a table'}
        </button>
      </figcaption>
      {says}
      {table && (
        <table className="odds-plot-table">
          <caption className="section-label">Runs by handover day</caption>
          <thead>
            <tr>
              <th scope="col">Handover</th>
              <th scope="col">Runs</th>
              <th scope="col">By then</th>
            </tr>
          </thead>
          <tbody>
            {table.map((row, index) => {
              const total = table.reduce((sum, entry) => sum + entry.count, 0);
              const byThen = table.slice(0, index + 1).reduce((sum, entry) => sum + entry.count, 0);
              return (
                <tr key={row.day} className={contractDay !== null && row.day > contractDay ? 'is-late' : 'is-on-time'}>
                  <td>{dayWords(row.day)}</td>
                  <td className="num">{row.count.toLocaleString('en-US')}</td>
                  <td className="num">{percentWords(percentOf(byThen, total))}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </figure>
  );
}
