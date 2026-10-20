/**
 * lib/auth-rate-limit.ts
 *
 * Sliding-window rate limiting for credential endpoints (login / signup).
 *
 * Why this exists: the sign-in endpoints are public. Without throttling, a
 * single compromised client (or script) can brute-force passwords at line
 * rate, and mass email signups can be used to poison `admin_profiles`
 * lookups. Supabase's built-in throttle is per-user and does not protect
 * against distributed attempts, so we keep our own window keyed by
 * (action, email) and (action, ip).
 *
 * Storage:
 *  - In-memory sliding window by default (correct for a single instance;
 *    the window resets on deploy, which is acceptable for this control).
 *  - If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are configured,
 *    the same limits are enforced through Upstash Redis so multi-instance
 *    deployments share one window. The Redis path degrades to the in-memory
 *    window if the Redis call fails (availability over strictness here —
 *    Supabase Auth's own account-lockout still applies).
 *
 * Pure module (no `next/*` imports) so it can be unit-tested directly.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until a slot frees up, when not allowed. */
  retryAfterSeconds?: number;
}

export interface RateLimitOptions {
  windowMs: number;
  maxAttempts: number;
}

/**
 * Defaults. 10 credential attempts per 15 minutes per email is plenty for a
 * human who mistypes a password, and tight enough to make automated
 * brute-forcing pointless. The IP window is looser to avoid blocking shared
 * NAT exits (campus networks, co-working offices) where many pastors share
 * one address.
 */
export const AUTH_RATE_LIMITS: Record<'login' | 'signup', Record<'email' | 'ip', RateLimitOptions>> = {
  login: {
    email: { windowMs: 15 * 60 * 1000, maxAttempts: 10 },
    ip: { windowMs: 15 * 60 * 1000, maxAttempts: 40 },
  },
  signup: {
    email: { windowMs: 15 * 60 * 1000, maxAttempts: 5 },
    ip: { windowMs: 15 * 60 * 1000, maxAttempts: 20 },
  },
};

type Bucket = number[]; // timestamps (ms) of attempts inside the current window

const memory = new Map<string, Bucket>();

function prune(bucket: Bucket, now: number, windowMs: number): Bucket {
  return bucket.filter((t) => now - t < windowMs);
}

function checkMemory(key: string, opts: RateLimitOptions, now: number): RateLimitDecision {
  const bucket = prune(memory.get(key) ?? [], now, opts.windowMs);
  if (bucket.length >= opts.maxAttempts) {
    const oldest = bucket[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + opts.windowMs - now) / 1000));
    // Keep the pruned bucket so the next call doesn't re-add noise.
    memory.set(key, bucket);
    return { allowed: false, retryAfterSeconds };
  }
  bucket.push(now);
  memory.set(key, bucket);
  return { allowed: true };
}

async function checkRedis(key: string, opts: RateLimitOptions, now: number): Promise<RateLimitDecision | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redisKey = `auth:rl:${key}`;
  const member = String(now);
  try {
    // Sliding window log, one REST round-trip.
    const res = await fetch(
      `${url.replace(/\/$/, '')}/`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([
          ['ZREMRANGEBYSCORE', redisKey, '0', String(now - opts.windowMs)],
          ['ZCARD', redisKey],
          ['ZADD', redisKey, member, member],
          ['PEXPIRE', redisKey, opts.windowMs],
        ]),
      }
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const count = Array.isArray(json) ? Number(json[1]) : NaN;
    if (!Number.isFinite(count)) return null;
    if (count >= opts.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(opts.windowMs / 1000)),
      };
    }
    return { allowed: true };
  } catch {
    return null; // Redis unavailable — fall back to the in-memory window.
  }
}

/**
 * Record one attempt and report whether it is within budget.
 *
 * `scope` is either 'email' or 'ip'; `identifier` the lowercased email or the
 * client IP. Loopback/unknown IPs are passed through untouched — callers are
 * expected to skip the IP check for those.
 */
export async function recordAuthAttempt(
  action: 'login' | 'signup',
  scope: 'email' | 'ip',
  identifier: string,
  now: number = Date.now()
): Promise<RateLimitDecision> {
  const opts = AUTH_RATE_LIMITS[action][scope];
  const key = `${action}:${scope}:${identifier}`;

  const redisDecision = await checkRedis(key, opts, now);
  if (redisDecision) return redisDecision;

  return checkMemory(key, opts, now);
}

/** Extract a best-effort client IP from request headers (proxy-aware). */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return headers.get('x-real-ip')?.trim() || '';
}

export const isLoopbackIp = (ip: string): boolean =>
  !ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === 'unknown';

/** Test-only: wipe the in-memory windows. */
export function resetAuthRateLimits(): void {
  memory.clear();
}
