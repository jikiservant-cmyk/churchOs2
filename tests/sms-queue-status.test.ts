import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasSmsQueueStatus, SMS_QUEUE_STATUS } from '../lib/sms-queue-status.ts';

test('SMS queue writes match the lowercase database contract', () => {
  assert.equal(SMS_QUEUE_STATUS.pending, 'pending');
  assert.equal(SMS_QUEUE_STATUS.processing, 'processing');
  assert.equal(SMS_QUEUE_STATUS.sent, 'sent');
  assert.equal(SMS_QUEUE_STATUS.failed, 'failed');
  assert.equal(SMS_QUEUE_STATUS.cancelled, 'cancelled');
});

test('queue status reads tolerate uppercase legacy rows during rollout', () => {
  assert.equal(hasSmsQueueStatus('PENDING', SMS_QUEUE_STATUS.pending), true);
  assert.equal(hasSmsQueueStatus('sent', SMS_QUEUE_STATUS.sent), true);
  assert.equal(hasSmsQueueStatus('FAILED', SMS_QUEUE_STATUS.failed), true);
  assert.equal(hasSmsQueueStatus('processing', SMS_QUEUE_STATUS.sent), false);
  assert.equal(hasSmsQueueStatus(null, SMS_QUEUE_STATUS.pending), false);
});

test('Edge SMS log upsert uses the unique idempotency conflict key declared by the base schema', () => {
  const edgeSource = readFileSync(new URL('../supabase/functions/church-najiki-dispatch/index.ts', import.meta.url), 'utf8');
  const schema = readFileSync(new URL('../supabase-schema.sql', import.meta.url), 'utf8');
  const logsTable = schema.match(/CREATE TABLE IF NOT EXISTS church\.sms_logs \(([\s\S]*?)\n\);/)?.[1] ?? '';
  assert.match(logsTable, /idempotency_key text UNIQUE NOT NULL/);
  assert.match(edgeSource, /onConflict: 'idempotency_key'/);
  assert.doesNotMatch(edgeSource, /onConflict: 'tenant_id,idempotency_key'/);
});
