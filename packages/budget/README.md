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
| `bk:{o:ORG}:res:<reqId>`              | hash, TTL 1 h | `amount`, `n`, and `h<i>`/`s<i>` key pairs     |
| `bk:{o:ORG}:resexp`                   | zset          | reqId by expiry (ms), for the sweeper          |
| `bk:{o:ORG}:kill`                     | set           | `org`, `key:<id>`, `prov:<name>`, `sess:<id>`  |

`<scope>` is `org`, `key:<id>`, `sku:<provider>:<sku>`, `env:<name>`, `sess:<id>` or `agent:<id>`.
`<window>` is `d:YYYYMMDD` or `m:YYYYMM` in the org's time zone. Window keys expire after 40 days
(day) or 400 days (month).

Differences from the design doc, agreed during Phase 1 review:

- Caps are stored per window kind (`d` / `m`), so they do not need rewriting every day.
- A reservation expires after 120 s, but its record lives 1 h so the sweeper can still settle it.
- The record stores both the `held` and the `spent` key for each pair.
- Sessions can be killed.
- Alert dedupe uses one hash per scope and window instead of one key per mark.

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
