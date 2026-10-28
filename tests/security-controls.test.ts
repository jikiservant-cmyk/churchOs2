import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, LocalWindowRateLimiter, getRateLimitIp } from '../lib/security/rate-limit.ts';
import { readBoundedJson } from '../lib/http/read-json.ts';
import { isSmsWithinSegmentLimit, smsSegmentCount } from '../supabase/functions/_shared/sms-length.ts';

describe('resource-abuse security controls', () => {
  it('enforces a fixed-window limit independently for each subject', () => {
    const limiter = new LocalWindowRateLimiter();
    assert.equal(limiter.check('church-a', 2, 60, 1_000).allowed, true);
    assert.equal(limiter.check('church-a', 2, 60, 2_000).allowed, true);
    const blocked = limiter.check('church-a', 2, 60, 3_000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 58);
    assert.equal(limiter.check('church-b', 2, 60, 3_000).allowed, true);
    assert.equal(limiter.check('church-a', 2, 60, 61_001).allowed, true);
  });

  it('charges weighted SMS usage against the volume ceiling', () => {
    const limiter = new LocalWindowRateLimiter();
    assert.equal(limiter.check('tenant-sms', 5, 3_600, 1_000, 3).allowed, true);
    assert.equal(limiter.check('tenant-sms', 5, 3_600, 2_000, 3).allowed, false);
    assert.equal(limiter.check('tenant-sms', 5, 3_600, 2_000, 2).allowed, true);
    assert.equal(limiter.check('tenant-sms', 5, 3_600, 2_000, 1).allowed, false);
  });

  it('falls back to in-memory limiter in production when shared storage is not configured', async () => {
    const env = process.env as Record<string, string | undefined>;
    const previousNodeEnv = env.NODE_ENV;
    const previousUrl = env.UPSTASH_REDIS_REST_URL;
    const previousToken = env.UPSTASH_REDIS_REST_TOKEN;
    env.NODE_ENV = 'production';
    delete env.UPSTASH_REDIS_REST_URL;
    delete env.UPSTASH_REDIS_REST_TOKEN;
    try {
      // Without Redis, production now degrades to local limiter so signups keep working.
      const first = await checkRateLimit({ namespace: 'test-fallback', subject: 'user-fallback', limit: 1, windowSeconds: 60 });
      assert.equal(first.allowed, true);
      const second = await checkRateLimit({ namespace: 'test-fallback', subject: 'user-fallback', limit: 1, windowSeconds: 60 });
      assert.equal(second.allowed, false);
      // Invalid options still fail closed
      assert.deepEqual(await checkRateLimit({ namespace: 'test', subject: '', limit: 1, windowSeconds: 60 }), {
        allowed: false,
        retryAfterSeconds: 60,
        unavailable: true,
      });
    } finally {
      if (previousNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousNodeEnv;
      if (previousUrl === undefined) delete env.UPSTASH_REDIS_REST_URL;
      else env.UPSTASH_REDIS_REST_URL = previousUrl;
      if (previousToken === undefined) delete env.UPSTASH_REDIS_REST_TOKEN;
      else env.UPSTASH_REDIS_REST_TOKEN = previousToken;
    }
  });

  it('bounds GSM-7 and Unicode SMS by billable segments, not just code points', () => {
    assert.equal(smsSegmentCount('a'.repeat(160)), 1);
    assert.equal(smsSegmentCount('a'.repeat(161)), 2);
    assert.equal(smsSegmentCount('a'.repeat(500)), 4);
    assert.equal(isSmsWithinSegmentLimit('a'.repeat(500)), true);
    assert.equal(isSmsWithinSegmentLimit('a'.repeat(613)), false);
    assert.equal(smsSegmentCount('😀'.repeat(134)), 4);
    assert.equal(isSmsWithinSegmentLimit('😀'.repeat(135)), false);
    assert.equal(smsSegmentCount('^'.repeat(81)), 2);
  });

  it('takes the rightmost forwarded IP and handles missing forwarding metadata', () => {
    assert.equal(getRateLimitIp(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })), '203.0.113.7');
    assert.equal(getRateLimitIp(new Headers({ 'x-real-ip': '203.0.113.8' })), '203.0.113.8');
    assert.equal(getRateLimitIp(new Headers({ 'cf-connecting-ip': '203.0.113.9, 203.0.113.10' })), '203.0.113.10');
    assert.equal(getRateLimitIp(new Headers({ 'x-vercel-forwarded-for': 'not-an-ip' })), 'unknown');
    assert.equal(getRateLimitIp(new Headers()), 'unknown');
  });

  it('reads Netlify and proxy IP headers and strips port suffixes', () => {
    assert.equal(getRateLimitIp(new Headers({ 'x-nf-client-connection-ip': '203.0.113.11' })), '203.0.113.11');
    assert.equal(getRateLimitIp(new Headers({ 'x-forwarded-for': '203.0.113.12:12345' })), '203.0.113.12');
    assert.equal(getRateLimitIp(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.13' })), '203.0.113.13');
    assert.equal(getRateLimitIp(new Headers({ 'x-nf-client-connection-ip': '198.51.100.5', 'x-forwarded-for': '203.0.113.14' })), '198.51.100.5');
  });

  it('rejects simple cross-origin form content types before parsing JSON', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"ok":true}',
    });
    assert.deepEqual(await readBoundedJson(request, 32), {
      ok: false,
      status: 415,
      error: 'Content-Type must be application/json.',
    });
  });

  it('rejects bodies exceeding the declared byte limit before parsing', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
      body: '{"ok":true}',
    });
    assert.deepEqual(await readBoundedJson(request, 32), {
      ok: false,
      status: 413,
      error: 'Request body is too large.',
    });
  });

  it('enforces the limit on streamed bodies and parses valid JSON', async () => {
    const tooLarge = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(100) }),
    });
    const oversizedResult = await readBoundedJson(tooLarge, 32);
    assert.equal(oversizedResult.ok, false);
    if (!oversizedResult.ok) assert.equal(oversizedResult.status, 413);

    const valid = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    assert.deepEqual(await readBoundedJson(valid, 32), { ok: true, value: { ok: true } });
  });
});
