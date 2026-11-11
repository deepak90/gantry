/**
 * Where the money goes: a stacked bar for each phase or each firm, on one scale. Each segment is a job, solid as far
 * as its money has gone out by the date and pale for the rest, so the chart follows the date like everything else.
 * Pointing at a segment names it and lights its plot; clicking goes into that work.
 */
import { type MoneyRow, rowSoFar, rowTotal } from './cost-breakdown';

export interface MoneyChartOptions {
  rows: readonly MoneyRow[];
  money: (minor: number) => string;
  hint: string;
  onHover: (key: unknown) => void;
  onOpen?: (key: unknown) => void;
}

export function createMoneyChart({ rows, money, hint, onHover, onOpen }: MoneyChartOptions): HTMLElement {
  const chart = document.createElement('div');
  chart.className = 'fx3d-money';
  const peak = Math.max(1, ...rows.map(rowTotal));
  const readout = document.createElement('p');
  readout.className = 'fx3d-money-readout';
  readout.textContent = hint;
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'fx3d-money-row';
    const head = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = row.label;
    const total = document.createElement('b');
    const [soFar, whole] = [rowSoFar(row), rowTotal(row)];
    total.textContent = soFar >= whole - 1 ? money(whole) : `${money(soFar)} of ${money(whole)}`;
    head.append(name, total);
    const bar = document.createElement('div');
    bar.className = 'fx3d-money-bar';
    bar.style.width = `${Math.max(2, (whole / peak) * 100)}%`;
    for (const segment of row.segments) {
      const piece = document.createElement(onOpen ? 'button' : 'span');
      piece.className = 'fx3d-money-seg';
      if (onOpen) (piece as HTMLButtonElement).type = 'button';
      piece.setAttribute('aria-label', `${segment.title}: ${money(segment.minor)}`);
      piece.style.flexGrow = String(segment.minor);
      piece.style.setProperty('--seg', segment.color);
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, segment.share * 100)}%`;
      piece.append(fill);
      piece.addEventListener('pointerenter', () => {
        readout.textContent = `${segment.title}: ${segment.share >= 0.999 ? money(segment.minor) : `${money(segment.minor * segment.share)} of ${money(segment.minor)}`}`;
        onHover(segment.key);
      });
      piece.addEventListener('pointerleave', () => {
        readout.textContent = hint;
        onHover(null);
      });
      if (onOpen) piece.addEventListener('click', () => onOpen(segment.key));
      bar.append(piece);
    }
    line.append(head, bar);
    chart.append(line);
  }
  chart.append(readout);
  return chart;
}
