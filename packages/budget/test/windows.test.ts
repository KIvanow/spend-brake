import { describe, expect, it } from 'vitest';
import { windowResetsAt, windowsFor } from '../src/windows.js';

describe('windows', () => {
  it('cuts day and month windows in the given time zone', () => {
    const at = new Date('2026-11-01T03:30:00Z');
    expect(windowsFor(at, 'UTC').map((w) => w.id)).toEqual(['d:20261101', 'm:202611']);
    // Still Oct 31 in Los Angeles.
    expect(windowsFor(at, 'America/Los_Angeles').map((w) => w.id)).toEqual([
      'd:20261031',
      'm:202610',
    ]);
  });

  it('gives day windows a 40-day TTL and month windows a 400-day TTL', () => {
    const [d, m] = windowsFor(new Date(), 'UTC');
    expect(d.ttlSec).toBe(40 * 86400);
    expect(m.ttlSec).toBe(400 * 86400);
  });

  it('computes reset times in UTC', () => {
    const at = new Date('2026-10-29T12:00:00Z');
    expect(windowResetsAt('d', at, 'UTC').toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(windowResetsAt('m', at, 'UTC').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(windowResetsAt('m', new Date('2026-12-15T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('handles DST changes', () => {
    // US DST ends 2026-11-01 at 02:00 PDT. Midnight Nov 1 is still PDT (UTC-7),
    // midnight Nov 2 is PST (UTC-8).
    const tz = 'America/Los_Angeles';
    expect(windowResetsAt('d', new Date('2026-10-31T20:00:00Z'), tz).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    expect(windowResetsAt('d', new Date('2026-11-01T20:00:00Z'), tz).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(windowResetsAt('m', new Date('2026-10-15T20:00:00Z'), tz).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
  });
});
