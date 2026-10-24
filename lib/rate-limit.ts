/**
 * lib/rate-limit.ts
 *
 * Shared throttling for unauthenticated, money-moving or message-moving server
 * actions (public donations, SMS initiation).
 *
 * `@upstash/ratelimit` is already a declared dependency of this app. It is used
 * here when `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are present,
 * which gives a correct limit across every replica of a multi-instance deploy.
 *
 * When Upstash is not configured we fall back to a bounded in-process fixed
 * window. That is weaker (per replica, lost on restart) but it is strictly
 * better than no limit at all, and it keeps single-instance `output:
 * 'standalone'` deployments protected without extra infrastructure.
 */

import { headers } from 'next/headers';

export interface RateLimitResult {
  success: boolean;
  /** Milliseconds the caller should wait before retrying. */
  retryAfterMs: number;
  remaining: number;
  /** Which backend produced the decision — useful in logs. */
  backend: 'upstash' | 'memory';
}

export interface RateLimitOptions {
  /** Maximum number of hits inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client IP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort client IP.
 *
 * `x-forwarded-for` is attacker-controlled unless the deployment sits behind a
 * trusted proxy that overwrites it. It is therefore acceptable for *throttling*
 * (a spoofing attacker only escapes their own bucket) but must never be used as
 * an authorization or uniqueness guarantee. Callers that need a trustworthy
 * identity must use the authenticated session instead.
 */
export async function getClientIp(): Promise<string> {
  try {
    const h = await headers();
    const xff = h.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    return h.get('x-real-ip')?.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process fallback
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
/** Hard cap so a flood of distinct keys cannot exhaust server memory. */
const MAX_BUCKETS = 20_000;

function memoryLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    if (buckets.size >= MAX_BUCKETS) {
      // Evict expired buckets first; if still full, drop the oldest reset time.
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) {
        let oldestKey: string | null = null;
        let oldest = Infinity;
        for (const [k, b] of buckets) {
          if (b.resetAt < oldest) {
            oldest = b.resetAt;
            oldestKey = k;
          }
        }
        if (oldestKey) buckets.delete(oldestKey);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { success: true, retryAfterMs: 0, remaining: opts.limit - 1, backend: 'memory' };
  }

  existing.count += 1;
  const retryAfterMs = Math.max(0, existing.resetAt - now);
  if (existing.count > opts.limit) {
    return { success: false, retryAfterMs, remaining: 0, backend: 'memory' };
  }
  return { success: true, retryAfterMs, remaining: opts.limit - existing.count, backend: 'memory' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash backend
// ─────────────────────────────────────────────────────────────────────────────

function upstashConfigured(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL ?? '').trim() &&
      (process.env.UPSTASH_REDIS_REST_TOKEN ?? '').trim(),
  );
}

async function upstashLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult | null> {
  try {
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');

    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(opts.limit, `${Math.round(opts.windowMs / 1000)} s`),
      prefix: 'churchos:rl',
      analytics: false,
    });

    const res = await limiter.limit(key);
    return {
      success: res.success,
      retryAfterMs: res.success ? 0 : (res.reset ?? Date.now() + opts.windowMs) - Date.now(),
      remaining: res.remaining,
      backend: 'upstash',
    };
  } catch (err) {
    // A rate-limiter outage must not become an availability outage for real
    // donors, but it also must not silently disable the control. Log loudly and
    // fall through to the in-process limiter so *some* ceiling still applies.
    console.error('[rate-limit] Upstash backend failed, using in-process fallback:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consume one unit from `key`'s budget.
 *
 * Fails **open** only in the sense that an Upstash outage degrades to the
 * in-process limiter — it never returns `success: true` unconditionally.
 */
export async function rateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  if (upstashConfigured()) {
    const res = await upstashLimit(key, opts);
    if (res) return res;
  }
  return memoryLimit(key, opts);
}

/** Human-readable "try again in N minutes" for user-facing errors. */
export function describeRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
