import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetEngine } from '../src/engine.js';
import { type Scope, keys, scopeLabel } from '../src/keys.js';
import { type TestValkey, newOrg, newReq, startValkey } from './valkey.js';

// The core invariant: committed + held never exceeds a hard cap by more than one request's
// worst case. Reserve checks the whole worst case up front, so with actual <= reserved the
// stronger bound committed + held <= cap holds at every instant; we assert that one.

const REQUESTS = 10_000;
const CONNECTIONS = 8;
const TZ = 'UTC';
const NOW = new Date('2026-10-29T12:00:00Z');
const DAY = 'd:20261029';
const MONTH = 'm:202610';

let valkey: TestValkey;

beforeAll(async () => {
  valkey = await startValkey();
});

afterAll(async () => {
  await valkey.stop();
});

/** mulberry32: a deterministic stream of numbers from the fast-check seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CapCase {
  scope: Scope;
  window: string;
  kind: 'd' | 'm';
  hard: bigint;
}

describe('budget invariant under concurrency', () => {
  it(`never lets ${REQUESTS} concurrent reserves push spend past a cap`, async () => {
    const engines = Array.from(
      { length: CONNECTIONS },
      () => new BudgetEngine(valkey.connect(), { reservationTtlMs: 60_000 }),
    );
    const sampler = valkey.connect();

    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 0, max: 40_000_000 }),
        async (seed, maxAmount, keyCap, skuCap, orgMonthCap) => {
          const org = newOrg();
          const k = keys(org);
          const rand = rng(seed);
          const keyScope: Scope = { kind: 'key', id: 'k1' };
          const skuScope: Scope = { kind: 'sku', provider: 'google-maps', sku: 'geocoding' };
          const orgScope: Scope = { kind: 'org' };
          const caps: CapCase[] = [
            { scope: keyScope, kind: 'd', window: DAY, hard: BigInt(keyCap) },
            { scope: skuScope, kind: 'd', window: DAY, hard: BigInt(skuCap) },
            { scope: orgScope, kind: 'm', window: MONTH, hard: BigInt(orgMonthCap) },
          ];
          for (const c of caps) {
            await engines[0]!.setCap(org, c.scope, c.kind, { hard: c.hard, soft: null });
          }
          const counterKeys = caps.flatMap((c) => [
            k.spent(scopeLabel(c.scope), c.window),
            k.held(scopeLabel(c.scope), c.window),
          ]);

          const violations: string[] = [];
          const check = async () => {
            // MGET is a single command, so it sees one consistent instant.
            const vals = await sampler.mget(...counterKeys);
            caps.forEach((c, i) => {
              const total = BigInt(vals[i * 2] ?? '0') + BigInt(vals[i * 2 + 1] ?? '0');
              if (total > c.hard) violations.push(`${scopeLabel(c.scope)} ${total} > ${c.hard}`);
            });
          };
          let running = true;
          let samples = 0;
          const sampling = (async () => {
            while (running) {
              await check();
              samples++;
            }
          })();

          let expectedSpent = 0n;
          let accepted = 0;
          const left: string[] = [];
          await Promise.all(
            Array.from({ length: REQUESTS }, async (_, i) => {
              const engine = engines[i % CONNECTIONS]!;
              const amount = BigInt(Math.floor(rand() * (maxAmount + 1)));
              const action = rand();
              const actual = BigInt(Math.floor(rand() * (Number(amount) + 1)));
              const reqId = newReq();
              const r = await engine.reserve({
                orgId: org,
                reqId,
                amount,
                scopes: [orgScope, keyScope, skuScope],
                killTargets: [{ kind: 'org' }],
                timeZone: TZ,
                now: NOW,
              });
              if (r.outcome === 'budget_exceeded') {
                if (r.spent + amount <= r.cap) violations.push(`bad deny ${r.spent}+${amount}`);
                return;
              }
              if (r.outcome !== 'ok') throw new Error(r.outcome);
              accepted++;
              if (action < 0.6) {
                await engine.commit(org, reqId, actual);
                expectedSpent += actual;
              } else if (action < 0.9) {
                await engine.refund(org, reqId);
              } else {
                left.push(reqId);
                expectedSpent += amount;
              }
            }),
          );

          // Whatever was left unsettled is swept at worst case once it expires.
          const swept = await engines[0]!.sweep(org, new Date(NOW.getTime() + 61_000), REQUESTS);
          expect(swept.committed).toBe(left.length);
          running = false;
          await sampling;
          await check();

          expect(violations).toEqual([]);
          expect(samples).toBeGreaterThan(1);
          if (caps.every((c) => c.hard >= BigInt(maxAmount))) {
            expect(accepted).toBeGreaterThan(0);
          }
          const status = await engines[0]!.status(org, [orgScope, keyScope, skuScope], TZ, NOW);
          for (const s of status) {
            expect(s.held).toBe(0n);
            expect(s.spent).toBe(expectedSpent);
          }
        },
      ),
      { numRuns: 5 },
    );
  });
});
