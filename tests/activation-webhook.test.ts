import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyActivationWebhook } from '../lib/activation/webhook-security.ts';
import { buildNotificationHeaders } from './fixtures/najiki/notification-signature.ts';

const body = JSON.stringify({ reference: 'ACT-TEST', amount: 17000, status: 'SUCCESS' });

describe('activation webhook authentication', () => {
  test('fails closed when no signing secret is configured', () => {
    const result = verifyActivationWebhook({
      rawBody: body,
      headers: new Headers(),
      secret: undefined,
    });

    assert.deepEqual(result, {
      ok: false,
      status: 503,
      error: 'Webhook secret not configured',
    });
  });

  test('accepts a correctly signed notification', () => {
    const secret = 'test-only-webhook-secret';
    const result = verifyActivationWebhook({
      rawBody: body,
      headers: new Headers(buildNotificationHeaders(secret, body)),
      secret,
    });

    assert.deepEqual(result, { ok: true });
  });

  test('rejects an unsigned activation notification when a secret is configured', () => {
    const result = verifyActivationWebhook({
      rawBody: body,
      headers: new Headers(),
      secret: 'test-only-webhook-secret',
    });

    assert.deepEqual(result, {
      ok: false,
      status: 401,
      error: 'Invalid webhook signature',
    });
  });
});
