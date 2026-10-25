import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

export interface RateLimitOptions {
  namespace: string;
  subject: string;
  limit: number;
  windowSeconds: number;
  /** Weighted cost for volume quotas (for example, billable SMS segments). */
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  unavailable?: boolean;
}

interface WindowRecord {
  count: number;
  resetAt: number;
}

/** Small local fallback for development only; production must use shared Redis. */
export class LocalWindowRateLimiter {
  private readonly records = new Map<string, WindowRecord>();

  check(key: string, limit: number, windowSeconds: number, now = Date.now(), cost = 1): RateLimitResult {
    if (!Number.isSafeInteger(cost) || cost < 1) {
      return { allowed: false, retryAfterSeconds: 60, unavailable: true };
    }
    let record = this.records.get(key);
    if (!record || now >= record.resetAt) {
      record = { count: 0, resetAt: now + windowSeconds * 1_000 };
    }
    if (record.count + cost > limit) {
      this.records.set(key, record);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1_000)) };
    }
    record.count += cost;
    this.records.set(key, record);
    if (this.records.size > 10_000) {
      for (const [storedKey, value] of this.records) {
        if (now >= value.resetAt) this.records.delete(storedKey);
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

const localLimiter = new LocalWindowRateLimiter();
const distributedLimiters = new Map<string, Ratelimit>();
let redis: Redis | null = null;

function opaqueKey(namespace: string, subject: string): string {
  return createHash('sha256').update(`${namespace}\0${subject}`).digest('hex');
}

/**
 * Shared sliding-window limiter. In production, missing or failing Redis is a
 * fail-closed service error; a process-local fallback is only for development.
 */
export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const cost = options.cost ?? 1;
  if (!options.subject || !Number.isSafeInteger(options.limit) || options.limit < 1 ||
      !Number.isSafeInteger(options.windowSeconds) || options.windowSeconds < 1 ||
      !Number.isSafeInteger(cost) || cost < 1 || cost > options.limit) {
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }

  const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!hasRedis) {
    if (process.env.NODE_ENV === 'production') {
      return { allowed: false, retryAfterSeconds: 60, unavailable: true };
    }
    return localLimiter.check(opaqueKey(options.namespace, options.subject), options.limit, options.windowSeconds, Date.now(), cost);
  }

  try {
    redis ??= Redis.fromEnv();
    const limiterKey = `${options.namespace}:${options.limit}:${options.windowSeconds}`;
    let limiter = distributedLimiters.get(limiterKey);
    if (!limiter) {
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(options.limit, `${options.windowSeconds} s`),
        prefix: `churchos:ratelimit:${limiterKey}`,
        analytics: false,
      });
      distributedLimiters.set(limiterKey, limiter);
    }
    const result = await limiter.limit(opaqueKey(options.namespace, options.subject), { rate: cost });
    return {
      allowed: result.success,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000)),
    };
  } catch (error) {
    console.error('[RateLimit] Shared limiter unavailable:', error instanceof Error ? error.message : 'unknown error');
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }
}

/** Prefer host-provided client IP headers; only accept syntactically valid IPs. */
export function getRateLimitIp(headers: Headers): string {
  const trustedHeaders = ['x-vercel-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];
  for (const header of trustedHeaders) {
    const raw = headers.get(header);
    if (!raw || raw.length > 512) continue;
    const candidate = raw.split(',').map((part) => part.trim()).filter(Boolean).at(-1);
    if (candidate && candidate.length <= 128 && isIP(candidate)) return candidate.toLowerCase();
  }
  return 'unknown';
}
