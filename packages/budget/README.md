# @spend-brake/budget

Atomic dollar budgets on Valkey. One Lua script per request reserves a request's worst-case cost
against every matching cap scope, or reserves nothing and names the scope that would overflow.

All money is integer micro-dollars (`bigint` in TypeScript, integers below 2^53 in Lua).

## Key layout

Every key for an org carries the hash tag `{o:<orgId>}`, so every script works on Valkey Cluster.

| Key                                   | Type          | Meaning                                        |
| ------------------------------------- | ------------- | ---------------------------------------------- |
| `bk:{o:ORG}:spent:<scope>:<window>`   | string int    | Committed micros                               |
| `bk:{o:ORG}:held:<scope>:<window>`    | string int    | Reserved, not yet settled                      |
| `bk:{o:ORG}:cap:<scope>:<d\|m>`       | hash          | `hard`, `soft`, `version`                      |
| `bk:{o:ORG}:alerted:<scope>:<window>` | hash          | Marks already fired: `50`, `80`, `100`, `soft` |
| `bk:{o:ORG}:res:<reqId>`              | hash, no TTL  | `amount`, `n`, and `h<i>`/`s<i>` key pairs     |
| `bk:{o:ORG}:resexp`                   | zset          | reqId by expiry (ms), for the sweeper          |
| `bk:{o:ORG}:kill`                     | set           | `org`, `key:<id>`, `prov:<name>`, `sess:<id>`  |
| `bk:{o:ORG}:circuit:key:<id>`         | string, TTL   | Loop circuit open until it expires             |
| `bk:{o:ORG}:loop:<keyId>:<hash>`      | int, TTL      | Identical requests in the loop window          |
| `bk:{o:ORG}:rate:<scope>`             | int, TTL 60 s | Requests per minute on a session (or key)      |
| `bk:{o:ORG}:units:<sku>:m:YYYYMM`     | int           | Billed units, for volume bands / free tier     |
| `bk:{o:ORG}:bsess:<prov>:<tokenHash>` | string, TTL   | Provider billing session already started       |
| `bk:{o:ORG}:events`                   | stream        | Usage and block events for the worker          |
| `bk:{o:ORG}:org`                      | string (JSON) | Org config (time zone, providers, loop policy) |
| `bk:vk:<sha256(token)>`               | string (JSON) | Virtual key record                             |

`bk:vk:*` is the one key outside an org hash tag: keys are looked up before the org is known. It
is a single-key read and never used inside a Lua script.

`<scope>` is `org`, `key:<id>`, `sku:<provider>:<sku>`, `env:<name>`, `sess:<id>` or `agent:<id>`.
`<window>` is `d:YYYYMMDD` or `m:YYYYMM` in the org's time zone. Window keys expire after 40 days
(day) or 400 days (month).

Differences from the design doc, agreed during Phase 1 review:

- Caps are stored per window kind (`d` / `m`), so they do not need rewriting every day.
- A reservation expires after 120 s, but its record has no TTL: only commit or the sweeper removes
  it, so a reserved amount can never stay counted after its record is gone.
- The record stores both the `held` and the `spent` key for each pair.
- Sessions can be killed.
- Alert dedupe uses one hash per scope and window instead of one key per mark. A mark fires once
  per window, even if a refund later drops spend below it.
- The first denied request in a window fires the `100` mark (`firstDeny: true`), since a request
  that no longer fits means the cap is reached for practical purposes.
- A denial reports `used` (committed plus held), not just committed spend.
- Reserving with a `reqId` that is still reserved throws instead of double-counting.

## Reserve, then settle

`reserve` also runs the loop check (kill set first, then the circuit, then the identical-request
and per-minute counters) and can create a scope's cap from a template on first use (session
budgets). It returns the smallest headroom left and a handle; `settle` takes that handle and, in
one call, commits the actual cost, counts billed units and appends the usage event.

Session scopes (`sess:<id>`) keep their window counters for two days only. `recordSpend` adds
spend that was never reserved (fail-open requests replayed after an outage). The events stream's
`MAXLEN` (10M) is a memory backstop; the worker trims it as the ledger consumes it.

## Usage

```ts
const engine = new BudgetEngine(valkey);
await engine.setCap(org, { kind: 'key', id: 'k1' }, 'd', { hard: 5_000_000n, soft: 4_000_000n });

const r = await engine.reserve({
  orgId: org,
  reqId,
  amount: worstCase,
  scopes: [{ kind: 'org' }, { kind: 'key', id: 'k1' }],
  killTargets: [{ kind: 'org' }, { kind: 'key', id: 'k1' }],
  timeZone: 'UTC',
});
// r.outcome: 'ok' (with threshold crossings) | 'budget_exceeded' | 'killed'

await engine.commit(org, reqId, actual); // or refund(), or commitWorstCase()
await engine.sweep(org); // run every 10 s from the worker
```
