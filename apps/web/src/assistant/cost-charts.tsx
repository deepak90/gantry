/**
 * Remy's cost charts, drawn from the live plan (cost-breakdown.ts does the sums):
 * - the building as a section: each floor a slab with its level mark, its bar built from a drafting
 *   line, bottom floor first, split by task in the color of who is paid;
 * - a ledger: one tall bar of who gets paid, then ranked bars that re-sort and resize in place when the
 *   breakdown switches between who's paid, by floor and by month;
 * - the cash flow: a playhead runs along the plan's dates and the running total climbs as each
 *   payment falls due.
 * Each animates in once (with reduced motion it is simply drawn). Every mark answers hover and focus
 * with its value first, lights its tasks' rows in the Gantt, and shows them there on a click. Every
 * chart has its table. Colors follow who is paid (a validated six-slot order; a seventh firm and on
 * fold into "Other"), and text stays in the ink colors.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { format, money as moneyOf, type ChartCard, type CurrencyCode } from '@collab/shared';
import { costBreakdown, levelMark, levelNumber, type CostBreakdown, type CostBy, type CostGroup } from './cost-breakdown';
import type { PlanCardEnv } from './plan-cards';
import { planClock } from '../plan-clock';
import '../styles/cost-charts.css';

export type CostChartKind = 'cost_section' | 'cost_ledger' | 'cash_flow';

const SLOTS = 6;
const EASE = [0.22, 1, 0.36, 1] as const;
const ease = {
  out: (t: number) => 1 - Math.pow(1 - t, 4),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Progress through one stretch [from, to] of an overall 0..1 progress. */
const phase = (p: number, from: number, to: number) => clamp01((p - from) / Math.max(0.0001, to - from));

function money(minor: number, currency: CurrencyCode): string {
  return format(moneyOf(Math.round(minor), currency)).replace(/\.00$/, '');
}

/** Axis money: $0, $5K, $1.2M. */
function compactMoney(minor: number): string {
  const dollars = minor / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}K`;
  return `$${Math.round(dollars)}`;
}

/** A round top for an axis (its half is round too): 1, 2, 3, 4, 5, 6 or 8 times a power of ten, at or above `value`. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** A total while it counts up: whole dollars, so the cents don't flicker; exact once it lands. */
const counting = (minor: number, share: number) => (share >= 1 ? minor : Math.round((minor * share) / 100) * 100);

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** 0 → 1 over `duration` once `delay` has passed, again whenever `run` changes; at once with reduced motion. */
function useProgress(run: number, duration: number, delay = 0): number {
  const reduce = useReducedMotion();
  const [progress, setProgress] = useState(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce || typeof requestAnimationFrame !== 'function') {
      setProgress(1);
      return undefined;
    }
    setProgress(0);
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = clamp01((now - start) / duration);
      setProgress(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, reduce, duration, delay]);
  return progress;
}

/** Who is paid, in the order that picks their color: largest first; a seventh and on are "Other". */
function payeeColors(payees: readonly CostGroup[]): Map<string, string> {
  return new Map(payees.map((payee, index) => [payee.name, index < SLOTS ? `var(--viz-${index + 1})` : 'var(--viz-other)']));
}

interface Tip {
  x: number;
  y: number;
  value: string;
  lines: string[];
  color: string | null;
}

/** The marks' shared behavior: the tooltip (value first), the rows lit in the Gantt, a click to show them. */
function useMarks(host: RefObject<HTMLDivElement | null>, env: PlanCardEnv) {
  const [tip, setTip] = useState<Tip | null>(null);
  const unmark = useRef<(() => void) | null>(null);
  useEffect(() => () => unmark.current?.(), []);
  const leave = () => {
    setTip(null);
    unmark.current?.();
    unmark.current = null;
  };
  const enter = (target: Element, value: string, lines: string[], color: string | null, ids: readonly number[]) => {
    const box = host.current?.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (box) setTip({ x: Math.min(box.width - 84, Math.max(84, rect.left - box.left + rect.width / 2)), y: rect.top - box.top, value, lines, color });
    unmark.current?.();
    unmark.current = env.markTasks?.(ids) ?? null;
  };
  /** Everything a mark needs: focusable, named, and answering hover, focus, click and Enter. */
  const mark = (value: string, lines: string[], color: string | null, ids: readonly number[]) => ({
    tabIndex: 0,
    role: 'button' as const,
    'aria-label': `${lines.join(', ')}: ${value}`,
    className: 'cc-mark',
    onPointerEnter: (event: ReactPointerEvent<Element>) => enter(event.currentTarget, value, lines, color, ids),
    onPointerLeave: leave,
    onFocus: (event: { currentTarget: Element }) => enter(event.currentTarget, value, lines, color, ids),
    onBlur: leave,
    onClick: () => env.showTasks(ids),
    onKeyDown: (event: KeyboardEvent<Element>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        env.showTasks(ids);
      }
    },
  });
  return { tip, mark, enter, leave };
}

function TipView({ tip }: { tip: Tip | null }) {
  return (
    <AnimatePresence>
      {tip && (
        <motion.div
          key="tip"
          className="cc-tip"
          role="status"
          style={{ left: tip.x, top: tip.y }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
        >
          <strong>{tip.value}</strong>
          {tip.lines.map((line, index) => (
            <span key={index}>
              {index === 0 && tip.color && <i className="cc-tip-key" style={{ background: tip.color }} />}
              {line}
            </span>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Legend({ payees, colors }: { payees: readonly CostGroup[]; colors: Map<string, string> }) {
  if (payees.length < 2) return null;
  const shown = payees.slice(0, SLOTS);
  const others = payees.length - shown.length;
  return (
    <ul className="cc-legend" aria-label="Who is paid">
      {shown.map((payee) => (
        <li key={payee.key}>
          <i style={{ background: colors.get(payee.name) }} />
          {payee.name}
        </li>
      ))}
      {others > 0 && (
        <li>
          <i style={{ background: 'var(--viz-other)' }} />
          Other ({others})
        </li>
      )}
    </ul>
  );
}

function Hero({ minor, currency, caption }: { minor: number; currency: CurrencyCode; caption: ReactNode }) {
  return (
    <div className="cc-hero">
      <strong data-testid="cost-chart-total">{money(minor, currency)}</strong>
      <span>{caption}</span>
    </div>
  );
}

/** One of the three, with its table and Replay. */
export function CostChart({ kind, card, env }: { kind: CostChartKind; card: Partial<ChartCard>; env: PlanCardEnv }) {
  const ids = card.task_ids ?? null;
  const breakdown = useMemo(() => costBreakdown(env.project, ids), [env.dataVersion, ids?.join(',')]);
  const [run, setRun] = useState(0);
  const [table, setTable] = useState(false);
  if (env.partial) return <p className="ac-muted">Drawing the chart…</p>;
  if (!env.canViewCosts) return <p className="ac-muted">Costs are only shown to people who can see them.</p>;
  if (breakdown.totalMinor === 0) return <p className="ac-muted">Nothing here has a cost in the plan yet.</p>;
  return (
    <div className="cc" data-testid={`cost-chart-${kind}`}>
      {table ? (
        <>
          <Hero minor={breakdown.totalMinor} currency={env.currency} caption={`${breakdown.parts.length} ${breakdown.parts.length === 1 ? 'cost' : 'costs'}`} />
          <CostTable kind={kind} breakdown={breakdown} currency={env.currency} />
        </>
      ) : kind === 'cost_section' ? (
        <SectionChart key={run} breakdown={breakdown} env={env} run={run} />
      ) : kind === 'cost_ledger' ? (
        <LedgerChart key={run} breakdown={breakdown} env={env} run={run} initial={card.by ?? 'payee'} />
      ) : (
        <FlowChart key={run} breakdown={breakdown} env={env} run={run} />
      )}
      <div className="cc-foot">
        <button type="button" className="cc-link" onClick={() => setTable((shown) => !shown)} data-testid="cost-chart-table">
          {table ? 'Show the chart' : 'Show the table'}
        </button>
        {!table && (
          <button type="button" className="cc-link" onClick={() => setRun((count) => count + 1)}>
            <i className="fa fa-rotate-right" aria-hidden="true" /> Replay
          </button>
        )}
      </div>
    </div>
  );
}

function CostTable({ kind, breakdown, currency }: { kind: CostChartKind; breakdown: CostBreakdown; currency: CurrencyCode }) {
  if (kind === 'cash_flow') {
    return (
      <table className="cc-table">
        <thead>
          <tr>
            <th scope="col">Due</th>
            <th scope="col">Payment</th>
            <th scope="col">Running total</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.flow.map(({ part, runningMinor }) => (
            <tr key={part.key}>
              <td>{shortDate(part.due!)}</td>
              <td>
                {part.task} · {part.payee} · {money(part.amountMinor, currency)}
              </td>
              <td>{money(runningMinor, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="cc-table">
      <thead>
        <tr>
          <th scope="col">Where</th>
          <th scope="col">Task</th>
          <th scope="col">Paid to</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.parts.map((part) => (
          <tr key={part.key}>
            <td>{part.where}</td>
            <td>{part.task}</td>
            <td>{part.payee}</td>
            <td>{money(part.amountMinor, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- A · the building as a section ------------------------------------------------------------

function SectionChart({ breakdown, env, run }: { breakdown: CostBreakdown; env: PlanCardEnv; run: number }) {
  const host = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/\W/g, '');
  const { tip, mark } = useMarks(host, env);
  const colors = useMemo(() => payeeColors(breakdown.payees), [breakdown]);
  // The building: the top floor on top; groups that aren't floors (completion, site work) below, in plan order.
  const rows = useMemo(() => {
    const floors = breakdown.floors.filter((floor) => levelNumber(floor.name) !== null).sort((a, b) => levelNumber(b.name)! - levelNumber(a.name)!);
    const others = breakdown.floors.filter((floor) => levelNumber(floor.name) === null);
    return [...floors, ...others];
  }, [breakdown]);
  const STAGGER = 0.34;
  const ROW_DURATION = 1;
  const span = (rows.length - 1) * STAGGER + ROW_DURATION;
  const progress = useProgress(run, span * 1000 + 200, 120);
  const elapsed = progress * span;
  const W = 340;
  const ROW = 46;
  const TOP = 10;
  const X0 = 84;
  const X1 = W - 66;
  const top = niceMax(Math.max(...rows.map((row) => row.totalMinor)));
  const x = (minor: number) => X0 + (minor / top) * (X1 - X0);
  const H = TOP + rows.length * ROW + 22;
  const ticks = [0, top / 2, top];
  const tasks = new Set(breakdown.parts.map((part) => part.taskId)).size;
  return (
    <div className="cc-plot" ref={host}>
      <Hero minor={counting(breakdown.totalMinor, ease.outExpo(phase(progress, 0.15, 1)))} currency={env.currency} caption={`${tasks} ${tasks === 1 ? 'task' : 'tasks'} · ${rows.length} ${rows.length === 1 ? 'place' : 'places'}`} />
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="What the work costs, floor by floor, split by task and who is paid">
        <g className="cc-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={TOP - 4} y2={TOP + rows.length * ROW - 8} />
              <text x={x(tick)} y={H - 6} textAnchor="middle">
                {compactMoney(tick)}
              </text>
            </g>
          ))}
        </g>
        {rows.map((row, index) => {
          // Bottom floor first: the last row starts the build.
          const local = clamp01((elapsed - (rows.length - 1 - index) * STAGGER) / ROW_DURATION);
          const datum = ease.out(phase(local, 0, 0.3));
          const slab = ease.inOut(phase(local, 0.12, 0.5));
          const build = ease.out(phase(local, 0.35, 0.92));
          const totalIn = phase(local, 0.85, 1);
          const y = TOP + index * ROW;
          const parts = row.parts;
          let at = 0;
          const rowEnd = x(row.totalMinor);
          const reach = X0 + (rowEnd - X0) * build;
          return (
            <g key={row.key}>
              <g opacity={datum} transform={`translate(0 ${(1 - datum) * -6})`} {...mark(money(row.totalMinor, env.currency), [row.name, `${row.taskIds.length} ${row.taskIds.length === 1 ? 'task' : 'tasks'}`], null, row.taskIds)}>
                <rect x={0} y={y} width={X0 - 6} height={ROW - 8} fill="transparent" />
                <path d={`M5 ${y + 7} h9 l-4.5 6.5 z`} className="cc-datum" />
                <line x1={1} x2={19} y1={y + 13.5} y2={y + 13.5} className="cc-slab" />
                <text x={25} y={y + 14} className="cc-lbl-strong">
                  {levelMark(row.name)}
                </text>
                <text x={25} y={y + 27} className="cc-tick">
                  {row.taskIds.length} {row.taskIds.length === 1 ? 'task' : 'tasks'}
                </text>
              </g>
              <line x1={X0} x2={X0 + (X1 - X0) * slab} y1={y + 31} y2={y + 31} className="cc-slab" opacity={slab > 0 ? 1 : 0} />
              <clipPath id={`cc-build-${uid}-${index}`}>
                <rect x={X0 - 1} y={y + 6} width={Math.max(0, reach - X0 + 1)} height={22} />
              </clipPath>
              <g clipPath={`url(#cc-build-${uid}-${index})`}>
                {parts.map((part, k) => {
                  const from = at;
                  at += part.amountMinor;
                  const last = k === parts.length - 1;
                  const left = x(from) + (from > 0 ? 1 : 0);
                  const right = x(at) - (last ? 0 : 1);
                  const width = Math.max(0, right - left);
                  const r = last ? Math.min(4, width / 2) : 0;
                  const topY = y + 8;
                  const bottomY = y + 26;
                  const color = colors.get(part.payee) ?? 'var(--viz-other)';
                  const word = part.task.split(/[\s,]+/)[0] ?? '';
                  const fits = width > word.length * 6.3 + 14;
                  return (
                    <g key={part.key}>
                      <path
                        d={`M${left} ${topY} H${right - r} Q${right} ${topY} ${right} ${topY + r} V${bottomY - r} Q${right} ${bottomY} ${right - r} ${bottomY} H${left} Z`}
                        fill={color}
                        {...mark(money(part.amountMinor, env.currency), [part.label === part.task ? part.task : `${part.task}: ${part.label}`, `${row.name} · ${part.payee}`], color, [part.taskId])}
                      />
                      {fits && (
                        <text x={left + 7} y={y + 20.5} className="cc-in-label" aria-hidden="true">
                          {word}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
              <text x={rowEnd + 8} y={y + 21} className="cc-lbl-strong" opacity={totalIn} aria-hidden="true">
                {money(row.totalMinor, env.currency)}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend payees={breakdown.payees} colors={colors} />
      <TipView tip={tip} />
    </div>
  );
}

// ---- B · the ledger ---------------------------------------------------------------------------

const BY_LABEL: Record<CostBy, string> = { payee: "Who's paid", floor: 'By floor', month: 'By month' };

function LedgerChart({ breakdown, env, run, initial }: { breakdown: CostBreakdown; env: PlanCardEnv; run: number; initial: CostBy }) {
  const host = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const clip = useId().replace(/\W/g, '');
  const { tip, mark } = useMarks(host, env);
  const colors = useMemo(() => payeeColors(breakdown.payees), [breakdown]);
  const [by, setBy] = useState<CostBy>(initial);
  const [switched, setSwitched] = useState(false);
  const progress = useProgress(run, 1900, 100);
  const sweep = ease.inOut(phase(progress, 0, 0.5));
  const sheen = phase(progress, 0.5, 0.86);
  const total = breakdown.totalMinor;
  const W = 340;
  const X0 = 2;
  const X1 = W - 2;
  const BAR_H = 28;
  const groups = by === 'payee' ? breakdown.payees : by === 'floor' ? breakdown.floors : breakdown.months;
  const max = Math.max(1, ...groups.map((group) => group.totalMinor));
  const LIST_TOP = 50;
  const ROW = 28;
  const LABEL_W = 136;
  const bx = X0 + LABEL_W;
  const bw = X1 - bx - 64;
  const H = LIST_TOP + groups.length * ROW + 2;
  let at = 0;
  return (
    <div className="cc-plot" ref={host}>
      <Hero minor={counting(total, ease.outExpo(phase(progress, 0.05, 0.9)))} currency={env.currency} caption={`to ${breakdown.payees.length} ${breakdown.payees.length === 1 ? 'firm' : 'firms'}`} />
      <div className="cc-chips" role="group" aria-label="Break it down">
        {(['payee', 'floor', 'month'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="cc-chip"
            aria-pressed={by === option}
            onClick={() => {
              setSwitched(true);
              setBy(option);
            }}
          >
            {by === option && <motion.span layoutId={`cc-chip-${clip}`} className="cc-chip-pill" transition={{ duration: reduce ? 0 : 0.3, ease: EASE }} />}
            <span>{BY_LABEL[option]}</span>
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Who gets paid, then each part ranked ${BY_LABEL[by].toLowerCase()}`}>
        <defs>
          <clipPath id={`cc-sweep-${clip}`}>
            <rect x={X0 - 1} y={0} width={(X1 - X0 + 2) * sweep} height={BAR_H + 4} />
          </clipPath>
          <linearGradient id={`cc-sheen-${clip}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* The whole, by who is paid: each part its own block. */}
        <g clipPath={`url(#cc-sweep-${clip})`}>
          {breakdown.payees.map((payee, index) => {
            const left = X0 + (at / total) * (X1 - X0) + (index ? 1 : 0);
            at += payee.totalMinor;
            const right = X0 + (at / total) * (X1 - X0) - (index < breakdown.payees.length - 1 ? 1 : 0);
            const width = Math.max(0, right - left);
            const color = colors.get(payee.name)!;
            const share = Math.round((payee.totalMinor / total) * 100);
            return (
              <g key={payee.key}>
                <rect x={left} y={2} width={width} height={BAR_H} rx={Math.min(4, width / 2)} fill={color} {...mark(money(payee.totalMinor, env.currency), [payee.name, `${share}% of it`], color, payee.taskIds)} />
                {width > 38 && (
                  <text x={left + 8} y={2 + BAR_H / 2 + 4} className="cc-in-label" aria-hidden="true">
                    {share}%
                  </text>
                )}
              </g>
            );
          })}
        </g>
        {sheen > 0 && sheen < 1 && <rect x={X0 - 70 + (X1 - X0 + 70) * ease.inOut(sheen)} y={2} width={70} height={BAR_H} fill={`url(#cc-sheen-${clip})`} pointerEvents="none" />}
        {/* Each part, ranked: the same row moves and resizes in place; another breakdown's rows fade. */}
        <AnimatePresence initial={false}>
          {groups.map((group, index) => {
            const width = Math.max(2, (group.totalMinor / max) * bw);
            const color = by === 'payee' ? colors.get(group.name)! : 'var(--viz-1)';
            const enter = switched ? index * 0.05 : 0.75 + index * 0.1;
            const y = LIST_TOP + index * ROW;
            return (
              <motion.g
                key={`${by}:${group.key}`}
                initial={reduce ? false : { opacity: 0, y }}
                animate={{ opacity: 1, y }}
                exit={{ opacity: 0, transition: { duration: 0.18 } }}
                transition={{ duration: reduce ? 0 : 0.5, ease: EASE, delay: reduce ? 0 : enter }}
              >
                {by === 'payee' && <circle cx={X0 + 5} cy={11} r={4} fill={color} />}
                <text x={by === 'payee' ? X0 + 15 : X0} y={15} className="cc-lbl">
                  {group.name.length > 22 ? `${group.name.slice(0, 21)}…` : group.name}
                </text>
                <g {...mark(money(group.totalMinor, env.currency), [group.name, `${Math.round((group.totalMinor / total) * 100)}% of the total`], by === 'payee' ? color : null, group.taskIds)}>
                  <rect x={bx} y={2} width={bw + 60} height={18} fill="transparent" />
                  <motion.rect
                    x={bx}
                    y={4}
                    height={14}
                    rx={4}
                    fill={color}
                    initial={reduce ? false : { width: 0 }}
                    animate={{ width }}
                    transition={{ duration: reduce ? 0 : 0.6, ease: EASE, delay: reduce ? 0 : enter }}
                  />
                  {/* Square where the bar meets its baseline. */}
                  <rect x={bx} y={4} width={Math.min(4, width)} height={14} fill={color} />
                </g>
                <motion.text
                  y={15}
                  className="cc-lbl-strong"
                  initial={reduce ? false : { x: bx + 8, opacity: 0 }}
                  animate={{ x: bx + width + 8, opacity: 1 }}
                  transition={{ duration: reduce ? 0 : 0.6, ease: EASE, delay: reduce ? 0 : enter }}
                  aria-hidden="true"
                >
                  {money(group.totalMinor, env.currency)}
                </motion.text>
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>
      <Legend payees={breakdown.payees} colors={colors} />
      <TipView tip={tip} />
    </div>
  );
}

// ---- C · the cash flow ------------------------------------------------------------------------

function FlowChart({ breakdown, env, run }: { breakdown: CostBreakdown; env: PlanCardEnv; run: number }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const clip = useId().replace(/\W/g, '');
  const { tip, mark, enter, leave } = useMarks(host, env);
  const [hover, setHover] = useState<number | null>(null);
  const colors = useMemo(() => payeeColors(breakdown.payees), [breakdown]);
  const progress = useProgress(run, 2800, 250);
  const flow = breakdown.flow;
  const W = 340;
  const H = 214;
  const L = 40;
  const R = W - 8;
  const T = 18;
  const B = H - 30;
  const day = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
  const first = flow.length > 0 ? day(flow[0]!.part.due!) : planClock.now().getTime();
  const last = flow.length > 0 ? day(flow.at(-1)!.part.due!) : planClock.now().getTime();
  const pad = Math.max(3 * 86_400_000, (last - first) * 0.06);
  const start = first - pad;
  const end = Math.max(last + pad, start + 14 * 86_400_000);
  const x = (iso: string) => L + ((day(iso) - start) / (end - start)) * (R - L);
  const top = niceMax(breakdown.totalMinor);
  const y = (minor: number) => B - (minor / top) * (B - T);
  const ticks = [0, top / 2, top];
  // Month marks along the bottom, as the Gantt's header has them.
  const months: { at: number; name: string }[] = [];
  for (const date = new Date(start); date.getTime() <= end; date.setMonth(date.getMonth() + 1, 1)) {
    const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    if (firstOfMonth >= start && firstOfMonth <= end) months.push({ at: L + ((firstOfMonth - start) / (end - start)) * (R - L), name: new Date(firstOfMonth).toLocaleDateString('en-US', { month: 'short' }) });
  }
  // The running total as a step: money goes out on the day it falls due.
  let path = `M${L} ${y(0)}`;
  let running = 0;
  for (const step of flow) {
    const at = x(step.part.due!);
    path += ` L${at.toFixed(1)} ${y(running).toFixed(1)} L${at.toFixed(1)} ${y(step.runningMinor).toFixed(1)}`;
    running = step.runningMinor;
  }
  path += ` L${R} ${y(running).toFixed(1)}`;
  const head = L + (R - L) * progress;
  const paid = flow.filter((step) => x(step.part.due!) <= head + 0.5).at(-1)?.runningMinor ?? 0;
  const largest = flow.reduce<(typeof flow)[number] | null>((best, step) => (!best || step.part.amountMinor > best.part.amountMinor ? step : best), null);
  const done = progress >= 1;
  const lastDue = flow.at(-1)?.part.due ?? null;
  // The crosshair finds the nearest payment along the dates.
  const onMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || flow.length === 0) return;
    const px = ((event.clientX - box.left) / box.width) * W;
    let nearest = 0;
    flow.forEach((step, index) => {
      if (Math.abs(x(step.part.due!) - px) < Math.abs(x(flow[nearest]!.part.due!) - px)) nearest = index;
    });
    setHover(nearest);
    const dot = svg.current?.querySelector(`[data-step="${nearest}"]`);
    const step = flow[nearest]!;
    if (dot) enter(dot, money(step.part.amountMinor, env.currency), [step.part.task, `${shortDate(step.part.due!)} · ${step.part.payee}`, `${money(step.runningMinor, env.currency)} paid out by then`], colors.get(step.part.payee) ?? null, [step.part.taskId]);
  };
  return (
    <div className="cc-plot" ref={host}>
      <Hero minor={done ? breakdown.totalMinor : paid} currency={env.currency} caption={lastDue ? `by ${longDate(lastDue)}` : 'no dates yet'} />
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="The running total of money going out, along the plan's dates">
        <defs>
          <clipPath id={`cc-flow-${clip}`}>
            <rect x={L - 2} y={0} width={Math.max(0, head - L + 2)} height={H} />
          </clipPath>
        </defs>
        <g className="cc-axis" aria-hidden="true">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={L} x2={R} y1={y(tick)} y2={y(tick)} />
              <text x={L - 6} y={y(tick) + 3} textAnchor="end">
                {compactMoney(tick)}
              </text>
            </g>
          ))}
          {months.map((month) => (
            <g key={month.at}>
              <line x1={month.at} x2={month.at} y1={B} y2={B + 4} />
              <text x={month.at} y={B + 16} textAnchor="middle">
                {month.name}
              </text>
            </g>
          ))}
        </g>
        <g clipPath={`url(#cc-flow-${clip})`}>
          <path d={`${path} L${R} ${B} L${L} ${B} Z`} className="cc-area" />
          <path d={path} className="cc-line" />
        </g>
        {hover !== null && done && <line x1={x(flow[hover]!.part.due!)} x2={x(flow[hover]!.part.due!)} y1={T - 6} y2={B} className="cc-crosshair" />}
        {!done && progress > 0 && <line x1={head} x2={head} y1={T - 8} y2={B} className="cc-playhead" />}
        {done && (
          <rect
            x={L}
            y={T - 8}
            width={R - L}
            height={B - T + 8}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => {
              setHover(null);
              leave();
            }}
          />
        )}
        {flow.map((step, index) => {
          const cx = x(step.part.due!);
          const cy = y(step.runningMinor);
          const passed = cx <= head + 0.5;
          const color = colors.get(step.part.payee) ?? 'var(--viz-other)';
          return (
            <motion.g
              key={step.part.key}
              data-step={index}
              initial={false}
              animate={{ opacity: passed ? 1 : 0, scale: passed ? 1 : 0.2 }}
              transition={{ duration: 0.32, ease: EASE }}
              style={{ transformOrigin: `${cx}px ${cy}px`, transformBox: 'view-box' }}
              {...mark(money(step.part.amountMinor, env.currency), [step.part.task, `${shortDate(step.part.due!)} · ${step.part.payee}`, `${money(step.runningMinor, env.currency)} paid out by then`], color, [step.part.taskId])}
            >
              <circle cx={cx} cy={cy} r={12} fill="transparent" />
              <circle cx={cx} cy={cy} r={hover === index ? 7.5 : 6.5} className="cc-ring" />
              <circle cx={cx} cy={cy} r={hover === index ? 5.5 : 4.5} fill={color} />
            </motion.g>
          );
        })}
        {largest && largest !== flow.at(-1) && x(largest.part.due!) <= head && (
          <text x={Math.min(R - 110, x(largest.part.due!) + 8)} y={Math.min(B - 6, y(largest.runningMinor) + 18)} className="cc-lbl" aria-hidden="true">
            {largest.part.task.split(/[\s,]+/)[0]}, {money(largest.part.amountMinor, env.currency)}
          </text>
        )}
        {done && lastDue && (
          <text x={R} y={Math.max(T + 2, y(breakdown.totalMinor) - 10)} textAnchor="end" className="cc-lbl-strong" aria-hidden="true">
            {money(breakdown.totalMinor, env.currency)} by {shortDate(lastDue)}
          </text>
        )}
      </svg>
      <Legend payees={breakdown.payees} colors={colors} />
      <TipView tip={tip} />
    </div>
  );
}
