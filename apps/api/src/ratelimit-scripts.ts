// The rate limit algorithms, as Lua scripts that run atomically inside Valkey.
//
// Each takes KEYS[1] = the counter's base key and
//   ARGV = limit, window ms, cost, burst (token bucket capacity), stats key prefix
// and returns { allowed (0/1), remaining, reset (unix ms) }. Time comes from Valkey's clock,
// so every API instance and restart agrees. Each also counts the outcome in an hourly stats
// hash (`<stats prefix>:<hour>`, kept 8 days) so the dashboard needs no Postgres writes.
import type { RateLimitAlgorithm } from "@mybase/shared";

const PRELUDE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local function finish(allowed, remaining, reset)
  local stats = ARGV[5] .. ':' .. math.floor(now / 3600000)
  redis.call('HINCRBY', stats, allowed == 1 and 'allowed' or 'blocked', 1)
  redis.call('EXPIRE', stats, 691200)
  if remaining < 0 then remaining = 0 end
  return { allowed, math.floor(remaining), reset }
end
`;

/** A counter per window. Simple; allows up to 2× the limit across a window edge. */
const FIXED = `${PRELUDE}
local w = math.floor(now / window)
local key = KEYS[1] .. ':' .. w
local reset = (w + 1) * window
local used = tonumber(redis.call('GET', key) or '0')
if used + cost > limit then return finish(0, limit - used, reset) end
used = redis.call('INCRBY', key, cost)
if used == cost then redis.call('PEXPIRE', key, window + 1000) end
return finish(1, limit - used, reset)
`;

/**
 * The previous window's count, weighted by how much of it still overlaps the sliding
 * window, plus the current one. Smooth, and only two counters per id.
 */
const SLIDING = `${PRELUDE}
local w = math.floor(now / window)
local cur_key = KEYS[1] .. ':' .. w
local cur = tonumber(redis.call('GET', cur_key) or '0')
local prev = tonumber(redis.call('GET', KEYS[1] .. ':' .. (w - 1)) or '0')
local weight = 1 - (now % window) / window
local used = prev * weight + cur
local reset = (w + 1) * window
if used + cost > limit then return finish(0, limit - used, reset) end
cur = redis.call('INCRBY', cur_key, cost)
if cur == cost then redis.call('PEXPIRE', cur_key, window * 2 + 1000) end
return finish(1, limit - used - cost, reset)
`;

/** `burst` tokens, refilled continuously at `limit` per `window`. Allows short bursts. */
const TOKEN = `${PRELUDE}
local capacity = tonumber(ARGV[4])
local rate = limit / window
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end
local full_in = math.ceil((capacity - tokens) / rate)
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], full_in + 1000)
return finish(allowed, tokens, now + full_in)
`;

const sha1 = (source: string) => new Bun.CryptoHasher("sha1").update(source).digest("hex");

export const SCRIPTS: Record<RateLimitAlgorithm, { source: string; sha: string }> = {
  fixed: { source: FIXED, sha: sha1(FIXED) },
  sliding: { source: SLIDING, sha: sha1(SLIDING) },
  token: { source: TOKEN, sha: sha1(TOKEN) },
};
