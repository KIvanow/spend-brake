import { createHash } from 'node:crypto';
import type { Cluster, Redis } from 'ioredis';

export type ValkeyClient = Redis | Cluster;

// Lua numbers are doubles. Every amount, cap and counter stays below 2^53 (enforced in the
// engine), so all arithmetic here is exact integer arithmetic.

/**
 * KEYS: kill, resexp, res, circuit, loop, rate, then (held, spent, cap, alerted) per
 *       (scope, window) pair
 * ARGV: amount, reqId, expiresAtMs, loopEnabled, identicalMax, loopWindowSec, perMinuteMax,
 *       cooldownSec, nKill, killTargets..., then
 *       (scopeLabel, windowId, windowTtlSec, defaultHard) per pair
 *
 * Returns {'KILLED', target} | {'LOOP', retryAfterSec, tripped} | {'DUPLICATE'}
 *       | {'DENY', scope, window, hard, used, firstDeny}
 *       | {'OK', {{scope, window, mark}, ...}, minRemaining}
 *
 * Loop check: `loop` counts identical requests in a fixed window, `rate` counts requests per
 * minute; going over either opens `circuit` for cooldownSec. tripped is 1 when this request
 * opened it. minRemaining is the smallest (hard - used) after this reservation, -1 if uncapped.
 *
 * defaultHard (may be '') creates the scope's hard cap on first use, e.g. a session budget.
 *
 * A deny changes no counter. It does set the scope's '100' alert mark (once per window), since a
 * request that does not fit means the cap has been reached for practical purposes; firstDeny is 1
 * when this deny set it.
 *
 * The res record has no TTL: commit or the sweeper deletes it. An expiring record would leave its
 * held amount counted until the window key expires.
 */
export const RESERVE_LUA = `
local amount = tonumber(ARGV[1])
local nKill = tonumber(ARGV[9])
for i = 1, nKill do
  if redis.call('SISMEMBER', KEYS[1], ARGV[9 + i]) == 1 then
    return {'KILLED', ARGV[9 + i]}
  end
end
if redis.call('EXISTS', KEYS[3]) == 1 then
  return {'DUPLICATE'}
end

if ARGV[4] == '1' then
  local open = redis.call('TTL', KEYS[4])
  if open > 0 then
    return {'LOOP', open, 0}
  end
  local same = redis.call('INCR', KEYS[5])
  redis.call('EXPIRE', KEYS[5], ARGV[6], 'NX')
  -- perMinuteMax 0 turns the rate rule off (requests without a session).
  local perMinute = 0
  if ARGV[7] ~= '0' then
    perMinute = redis.call('INCR', KEYS[6])
    redis.call('EXPIRE', KEYS[6], 60, 'NX')
  end
  if same > tonumber(ARGV[5]) or (ARGV[7] ~= '0' and perMinute > tonumber(ARGV[7])) then
    redis.call('SET', KEYS[4], '1', 'EX', ARGV[8])
    return {'LOOP', tonumber(ARGV[8]), 1}
  end
end

local first = 7
local n = (#KEYS - 6) / 4
local base = 9 + nKill
local used = {}
local caps = {}
for i = 0, n - 1 do
  local k = first + i * 4
  local a = base + i * 4
  local u = tonumber(redis.call('GET', KEYS[k]) or '0') + tonumber(redis.call('GET', KEYS[k + 1]) or '0')
  local cap = redis.call('HMGET', KEYS[k + 2], 'hard', 'soft')
  if not cap[1] and ARGV[a + 4] ~= '' then
    redis.call('HSET', KEYS[k + 2], 'hard', ARGV[a + 4])
    redis.call('HINCRBY', KEYS[k + 2], 'version', 1)
    redis.call('EXPIRE', KEYS[k + 2], ARGV[a + 3], 'NX')
    cap[1] = ARGV[a + 4]
  end
  local hard = tonumber(cap[1] or '-1')
  if hard >= 0 and u + amount > hard then
    local firstDeny = 0
    if hard > 0 and redis.call('HSETNX', KEYS[k + 3], '100', '1') == 1 then
      redis.call('EXPIRE', KEYS[k + 3], ARGV[a + 3], 'NX')
      firstDeny = 1
    end
    return {'DENY', ARGV[a + 1], ARGV[a + 2], hard, u, firstDeny}
  end
  used[i] = u
  caps[i] = {hard, tonumber(cap[2] or '-1')}
end

-- floor(hard * pct / 100) without overflowing 2^53
local function markOf(hard, pct)
  return math.floor(hard / 100) * pct + math.floor((hard % 100) * pct / 100)
end

local crossings = {}
local function cross(i, k, a, label, threshold)
  local before = used[i]
  if before < threshold and before + amount >= threshold then
    if redis.call('HSETNX', KEYS[k + 3], label, '1') == 1 then
      redis.call('EXPIRE', KEYS[k + 3], ARGV[a + 3], 'NX')
      table.insert(crossings, {ARGV[a + 1], ARGV[a + 2], label})
    end
  end
end

local minRemaining = -1
redis.call('HSET', KEYS[3], 'amount', ARGV[1], 'n', n)
for i = 0, n - 1 do
  local k = first + i * 4
  local a = base + i * 4
  local ttl = ARGV[a + 3]
  redis.call('INCRBY', KEYS[k], ARGV[1])
  redis.call('EXPIRE', KEYS[k], ttl, 'NX')
  redis.call('SET', KEYS[k + 1], '0', 'NX', 'EX', ttl)
  redis.call('HSET', KEYS[3], 'h' .. (i + 1), KEYS[k], 's' .. (i + 1), KEYS[k + 1])
  local hard, soft = caps[i][1], caps[i][2]
  if hard >= 0 then
    local left = hard - used[i] - amount
    if minRemaining < 0 or left < minRemaining then
      minRemaining = left
    end
  end
  if hard > 0 then
    cross(i, k, a, '50', markOf(hard, 50))
    cross(i, k, a, '80', markOf(hard, 80))
    cross(i, k, a, '100', hard)
  end
  if soft > 0 then
    cross(i, k, a, 'soft', soft)
  end
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
return {'OK', crossings, minRemaining}
`;

/**
 * KEYS: resexp, res, then (held, spent) per pair, read from the res record
 * ARGV: reqId, actual (-1 = commit at the reserved worst case)
 *
 * Returns {'SETTLED'} when the reservation is already gone, else {'OK', reservedAmount}.
 */
export const COMMIT_LUA = `
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return {'SETTLED'}
end
local amount = redis.call('HGET', KEYS[2], 'amount')
local actual = ARGV[2]
if actual == '-1' then
  actual = amount
end
for i = 3, #KEYS, 2 do
  redis.call('DECRBY', KEYS[i], amount)
  redis.call('INCRBY', KEYS[i + 1], actual)
end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
return {'OK', amount}
`;

/**
 * The proxy's one-round-trip settle: commit (as COMMIT_LUA), count billed units and append the
 * usage event. The proxy passes the (held, spent) keys it reserved, so no record read is needed.
 *
 * KEYS: resexp, res, events, then (held, spent) per pair, then one units key per SKU
 * ARGV: reqId, actual, nPairs, nUnits, unitsTtlSec, unitIncrements..., maxLen, then event
 *       field/value pairs
 *
 * The caller passes units only when the provider billed the request (even at a price of zero,
 * e.g. inside a trusted free allowance), so the counter always advances; they are counted even if
 * the sweeper settled first (it never counts them). The event gets `underpriced=1` when actual exceeds the reservation and `late=1` when
 * the reservation was already settled.
 */
export const SETTLE_LUA = `
local nPairs = tonumber(ARGV[3])
local nUnits = tonumber(ARGV[4])
local amount = false
local actual = ARGV[2]
if redis.call('EXISTS', KEYS[2]) == 1 then
  amount = redis.call('HGET', KEYS[2], 'amount')
  if actual == '-1' then
    actual = amount
  end
  for i = 0, nPairs - 1 do
    redis.call('DECRBY', KEYS[4 + i * 2], amount)
    redis.call('INCRBY', KEYS[5 + i * 2], actual)
  end
  redis.call('DEL', KEYS[2])
end
redis.call('ZREM', KEYS[1], ARGV[1])

for i = 1, nUnits do
  local key = KEYS[3 + nPairs * 2 + i]
  redis.call('INCRBY', key, ARGV[5 + i])
  redis.call('EXPIRE', key, ARGV[5], 'NX')
end

local first = 7 + nUnits
local fields = {}
for i = first, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
if amount and tonumber(actual) > tonumber(amount) then
  fields[#fields + 1] = 'underpriced'
  fields[#fields + 1] = '1'
end
if not amount then
  fields[#fields + 1] = 'late'
  fields[#fields + 1] = '1'
end
if #fields > 0 then
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', ARGV[6 + nUnits], '*', unpack(fields))
end
if amount then
  return {'OK', amount}
end
return {'SETTLED'}
`;

/**
 * Record spend that was never reserved: fail-open requests made while Valkey was unreachable,
 * replayed once it answers. Adds to `spent` on every pair, counts units and appends the event.
 *
 * KEYS: events, then spent per pair, then one units key per SKU
 * ARGV: amount, nPairs, nUnits, unitsTtlSec, pairTtlSec..., unitIncrements..., maxLen, then event
 *       field/value pairs
 */
export const RECORD_LUA = `
local nPairs = tonumber(ARGV[2])
local nUnits = tonumber(ARGV[3])
for i = 1, nPairs do
  redis.call('INCRBY', KEYS[1 + i], ARGV[1])
  redis.call('EXPIRE', KEYS[1 + i], ARGV[4 + i], 'NX')
end
for i = 1, nUnits do
  local key = KEYS[1 + nPairs + i]
  redis.call('INCRBY', key, ARGV[4 + nPairs + i])
  redis.call('EXPIRE', key, ARGV[4], 'NX')
end
local first = 6 + nPairs + nUnits
local fields = {}
for i = first, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
if #fields > 0 then
  redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[5 + nPairs + nUnits], '*', unpack(fields))
end
return 'OK'
`;

interface Script {
  source: string;
  sha: string;
}

function script(source: string): Script {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

export const scripts = {
  reserve: script(RESERVE_LUA),
  commit: script(COMMIT_LUA),
  settle: script(SETTLE_LUA),
  record: script(RECORD_LUA),
};

/** EVALSHA, falling back to EVAL when the script cache is cold (restart, failover, new node). */
export async function runScript(
  client: ValkeyClient,
  s: Script,
  keys: string[],
  args: (string | number)[],
): Promise<unknown> {
  try {
    return await client.evalsha(s.sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
      return client.eval(s.source, keys.length, ...keys, ...args);
    }
    throw err;
  }
}
