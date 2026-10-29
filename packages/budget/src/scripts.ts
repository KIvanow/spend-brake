import { createHash } from 'node:crypto';
import type { Cluster, Redis } from 'ioredis';

export type ValkeyClient = Redis | Cluster;

// Lua numbers are doubles. Every amount, cap and counter stays below 2^53 (enforced in the
// engine), so all arithmetic here is exact integer arithmetic.

/**
 * KEYS: kill, resexp, res, then (held, spent, cap, alerted) per (scope, window) pair
 * ARGV: amount, reqId, expiresAtMs, resTtlSec, nKill, killTargets..., then
 *       (scopeLabel, windowId, windowTtlSec) per pair
 *
 * Returns {'KILLED', target} | {'DUPLICATE'} | {'DENY', scope, window, hard, used}
 *       | {'OK', {{scope, window, mark}, ...}}
 */
export const RESERVE_LUA = `
local amount = tonumber(ARGV[1])
local nKill = tonumber(ARGV[5])
for i = 1, nKill do
  if redis.call('SISMEMBER', KEYS[1], ARGV[5 + i]) == 1 then
    return {'KILLED', ARGV[5 + i]}
  end
end
if redis.call('EXISTS', KEYS[3]) == 1 then
  return {'DUPLICATE'}
end

local n = (#KEYS - 3) / 4
local base = 5 + nKill
local used = {}
local caps = {}
for i = 0, n - 1 do
  local k = 4 + i * 4
  local u = tonumber(redis.call('GET', KEYS[k]) or '0') + tonumber(redis.call('GET', KEYS[k + 1]) or '0')
  local cap = redis.call('HMGET', KEYS[k + 2], 'hard', 'soft')
  local hard = tonumber(cap[1] or '-1')
  if hard >= 0 and u + amount > hard then
    return {'DENY', ARGV[base + i * 3 + 1], ARGV[base + i * 3 + 2], hard, u}
  end
  used[i] = u
  caps[i] = {hard, tonumber(cap[2] or '-1')}
end

-- floor(hard * pct / 100) without overflowing 2^53
local function markOf(hard, pct)
  return math.floor(hard / 100) * pct + math.floor((hard % 100) * pct / 100)
end

local crossings = {}
local function cross(i, k, label, threshold)
  local before = used[i]
  if before < threshold and before + amount >= threshold then
    if redis.call('HSETNX', KEYS[k + 3], label, '1') == 1 then
      redis.call('EXPIRE', KEYS[k + 3], ARGV[base + i * 3 + 3], 'NX')
      table.insert(crossings, {ARGV[base + i * 3 + 1], ARGV[base + i * 3 + 2], label})
    end
  end
end

redis.call('HSET', KEYS[3], 'amount', ARGV[1], 'n', n)
for i = 0, n - 1 do
  local k = 4 + i * 4
  local ttl = ARGV[base + i * 3 + 3]
  redis.call('INCRBY', KEYS[k], ARGV[1])
  redis.call('EXPIRE', KEYS[k], ttl, 'NX')
  redis.call('SET', KEYS[k + 1], '0', 'NX', 'EX', ttl)
  redis.call('HSET', KEYS[3], 'h' .. (i + 1), KEYS[k], 's' .. (i + 1), KEYS[k + 1])
  local hard, soft = caps[i][1], caps[i][2]
  if hard > 0 then
    cross(i, k, '50', markOf(hard, 50))
    cross(i, k, '80', markOf(hard, 80))
    cross(i, k, '100', hard)
  end
  if soft > 0 then
    cross(i, k, 'soft', soft)
  end
end
redis.call('EXPIRE', KEYS[3], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
return {'OK', crossings}
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
