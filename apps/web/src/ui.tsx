import { type ReactNode, useState } from 'react';
import { localDate, localDateTime, localZone, usd } from './api.js';

/** The brand mark and name, as on spendbrake.dev: a brake pad across a ring. */
export function Brand() {
  return (
    <>
      <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="ring" cx="16" cy="16" r="12.5" />
        <rect className="pad" x="8" y="14" width="16" height="4" rx="1" />
      </svg>
      Spend Brake
    </>
  );
}

/**
 * A time as the dashboard shows every time: in the browser's time zone, named in the tooltip
 * with the UTC original.
 */
export function Time({ iso, date = false }: { iso: string; date?: boolean }) {
  return (
    <time dateTime={iso} title={`Your time zone (${localZone()}); UTC: ${iso}`}>
      {date ? localDate(iso) : localDateTime(iso)}
    </time>
  );
}

/** Column label for times, so every table says the same thing. */
export const TIME_LABEL = 'Time (local)';

/** Copies a token or secret shown once. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Table<T>({
  rows,
  columns,
  empty = 'Nothing yet.',
}: {
  rows: T[];
  columns: { label: string; render: (row: T) => ReactNode; numeric?: boolean }[];
  empty?: string;
}) {
  if (rows.length === 0) return <p className="muted empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.numeric ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.label} className={c.numeric ? 'num' : undefined}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Spend per day as bars; values in micros. */
export function BarChart({ data }: { data: { label: string; value: number }[] }) {
  if (data.length === 0) return <p className="muted empty">No spend in this period.</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100 / data.length;
  return (
    <figure className="chart" aria-label="Spend per day">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img">
        {data.map((d, i) => {
          const h = (d.value / max) * 38;
          return (
            <rect key={d.label} x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={h}>
              <title>{`${d.label}: ${usd(d.value, 4)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption>
        <span>{data[0]!.label}</span>
        <span>peak {usd(max)}</span>
        <span>{data.at(-1)!.label}</span>
      </figcaption>
    </figure>
  );
}

export function Meter({ spent, hard }: { spent: number; hard: number | null }) {
  if (!hard) return <span className="muted">no cap</span>;
  const pct = Math.min(100, Math.round((spent / hard) * 100));
  return (
    <span className="meter" title={`${pct}% of ${usd(hard)}`}>
      <span className={pct >= 80 ? 'fill warn' : 'fill'} style={{ width: `${pct}%` }} />
    </span>
  );
}

export const windowName = (w: string) =>
  w.startsWith('d:')
    ? `today (${w.slice(2, 6)}-${w.slice(6, 8)}-${w.slice(8)})`
    : `month (${w.slice(2, 6)}-${w.slice(6)})`;
