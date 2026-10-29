import type { WindowKind } from './keys.js';

export const DAY_WINDOW_TTL_SEC = 40 * 24 * 3600;
export const MONTH_WINDOW_TTL_SEC = 400 * 24 * 3600;

export interface Window {
  kind: WindowKind;
  /** `d:YYYYMMDD` or `m:YYYYMM` in the org's time zone. */
  id: string;
  ttlSec: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localTime(at: Date, timeZone: string): LocalTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function windowsFor(now: Date, timeZone: string): [Window, Window] {
  const t = localTime(now, timeZone);
  return [
    { kind: 'd', id: `d:${t.year}${pad(t.month)}${pad(t.day)}`, ttlSec: DAY_WINDOW_TTL_SEC },
    { kind: 'm', id: `m:${t.year}${pad(t.month)}`, ttlSec: MONTH_WINDOW_TTL_SEC },
  ];
}

/** UTC instant of a local wall-clock midnight in `timeZone`. */
function localMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const offsetAt = (utcMs: number) => {
    const t = localTime(new Date(utcMs), timeZone);
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - utcMs;
  };
  // Two passes settle the offset when a DST change sits between the guess and the answer.
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc);
}

/** When the current day or month window ends, in UTC. */
export function windowResetsAt(kind: WindowKind, now: Date, timeZone: string): Date {
  const t = localTime(now, timeZone);
  if (kind === 'd') {
    const next = new Date(Date.UTC(t.year, t.month - 1, t.day + 1));
    return localMidnightToUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      timeZone,
    );
  }
  const next = new Date(Date.UTC(t.year, t.month, 1));
  return localMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, timeZone);
}
