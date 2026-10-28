import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readQueueMessage, SMS_QUEUE_MESSAGE_COLUMNS } from '../lib/sms-queue-message.ts';

const queueActions = readFileSync(new URL('../lib/queue-actions.ts', import.meta.url), 'utf8');
const smsDispatch = readFileSync(new URL('../lib/sms-dispatch.ts', import.meta.url), 'utf8');

/** Pull the object literal a queue insert actually sends. */
function insertPayload(source: string, start: RegExp): string {
  const match = start.exec(source);
  assert.ok(match, `could not locate insert payload with ${start}`);
  const from = match.index;
  const end = source.indexOf('});', from);
  return source.slice(from, end === -1 ? undefined : end);
}

test('sms_queue rows are read from the deployed body column, with a legacy fallback', () => {
  assert.equal(SMS_QUEUE_MESSAGE_COLUMNS[0], 'body');
  assert.equal(readQueueMessage({ body: 'Hello from body' }), 'Hello from body');
  assert.equal(readQueueMessage({ message: 'Hello from legacy message' }), 'Hello from legacy message');
  assert.equal(readQueueMessage({ body: 'body wins', message: 'legacy' }), 'body wins');
  assert.equal(readQueueMessage({ body: null, message: 'legacy' }), 'legacy');
  assert.equal(readQueueMessage({ id: 'row' }), undefined);
  assert.equal(readQueueMessage(null), undefined);
});

test('broadcast inserts send the SMS text as body and never as message', () => {
  const payload = insertPayload(queueActions, /rows\.push\(\{/);
  assert.match(payload, /body: message,/);
  assert.doesNotMatch(payload, /\n\s+message,/);
  assert.doesNotMatch(payload, /message:/);
});

test('single SMS inserts send the SMS text as body and never as message', () => {
  const payload = insertPayload(smsDispatch, /const row = \{/);
  assert.match(payload, /body: message,/);
  assert.doesNotMatch(payload, /\n\s+message,/);
  assert.doesNotMatch(payload, /recipient_id/);
});

test('queue inserts never name the missing recipient_id column', () => {
  // The deployed church.sms_queue has no recipient_id column, so a REST insert
  // that includes it fails with 400/PGRST204 before any row is queued.
  const broadcastPayload = insertPayload(queueActions, /rows\.push\(\{/);
  assert.doesNotMatch(broadcastPayload, /recipient_id/);
  const singlePayload = insertPayload(smsDispatch, /const row = \{/);
  assert.doesNotMatch(singlePayload, /recipient_id/);
});
