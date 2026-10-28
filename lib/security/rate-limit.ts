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

/** In-memory fallback used when shared Redis is not configured or temporarily unavailable.
 * In production this is a degraded mode (single-instance) — set Upstash Redis for
 * distributed protection across instances. */
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
 * Shared sliding-window limiter. When Upstash Redis is configured, it is the
 * primary distributed limiter. When it is missing or temporarily unavailable,
 * we degrade to an in-memory limiter so signups and other critical flows do
 * not hard-fail in production (single-instance rate limiting is better than
 * a 100% outage). Invalid options still fail closed with `unavailable:true`.
 */
export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const cost = options.cost ?? 1;
  if (!options.subject || !Number.isSafeInteger(options.limit) || options.limit < 1 ||
      !Number.isSafeInteger(options.windowSeconds) || options.windowSeconds < 1 ||
      !Number.isSafeInteger(cost) || cost < 1 || cost > options.limit) {
    return { allowed: false, retryAfterSeconds: 60, unavailable: true };
  }

  const opaque = opaqueKey(options.namespace, options.subject);
  const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!hasRedis) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[RateLimit] Upstash Redis not configured — using in-memory limiter. Set UPSTASH_REDIS_REST_URL/TOKEN for distributed protection.');
    }
    return localLimiter.check(opaque, options.limit, options.windowSeconds, Date.now(), cost);
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
    const result = await limiter.limit(opaque, { rate: cost });
    return {
      allowed: result.success,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000)),
    };
  } catch (error) {
    console.error('[RateLimit] Shared limiter unavailable:', error instanceof Error ? error.message : 'unknown error');
    console.warn('[RateLimit] Falling back to in-memory limiter so requests can continue.');
    return localLimiter.check(opaque, options.limit, options.windowSeconds, Date.now(), cost);
  }
}

/** Normalize a raw header fragment into a bare IP (strip port/brackets) if possible. */
function normalizeIpCandidate(rawValue: string): string | null {
  let candidate = rawValue.trim();
  if (!candidate || candidate.length > 128) return null;
  // Strip surrounding brackets for IPv6 like [2001:db8::1] or [2001:db8::1]:443
  if (candidate.startsWith('[')) {
    const end = candidate.indexOf(']');
    if (end !== -1) candidate = candidate.slice(1, end);
  } else if (candidate.includes(':') && candidate.includes('.')) {
    // Likely IPv4 with port: 203.0.113.1:12345 -> strip :port
    // Only strip trailing :<digits> when there is exactly one ':' before port
    const lastColon = candidate.lastIndexOf(':');
    const after = candidate.slice(lastColon + 1);
    if (/^\d{1,5}$/.test(after)) {
      const before = candidate.slice(0, lastColon);
      if (isIP(before)) candidate = before;
    }
  }
  candidate = candidate.trim().toLowerCase();
  if (!candidate) return null;
  return isIP(candidate) ? candidate : null;
}

/** Prefer host-provided client IP headers; only accept syntactically valid IPs.
 * Supports Vercel, Cloudflare, Netlify (x-nf-client-connection-ip), and generic
 * reverse proxies. Checks multiple comma-separated values and picks the last
 * valid IP to align with existing deployment behaviour. */
export function getRateLimitIp(headers: Headers): string {
  const trustedHeaders = [
    'x-nf-client-connection-ip',
    'x-vercel-forwarded-for',
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip',
    'x-forwarded-for',
  ];
  for (const header of trustedHeaders) {
    const raw = headers.get(header);
    if (!raw || raw.length > 512) continue;
    const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
    // Iterate from last to first (closest proxy first) but accept the first valid we find from the end
    for (let i = parts.length - 1; i >= 0; i--) {
      const normalized = normalizeIpCandidate(parts[i]!);
      if (normalized) return normalized;
    }
  }
  return 'unknown';
}
