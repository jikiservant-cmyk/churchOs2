import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUnknownColumnError,
  readQueueMessage,
  SMS_QUEUE_MESSAGE_COLUMNS,
} from '../lib/sms-queue-message.ts';

test('sms_queue SMS text is written to the deployed body column first', () => {
  assert.equal(SMS_QUEUE_MESSAGE_COLUMNS[0], 'body');
  assert.equal(SMS_QUEUE_MESSAGE_COLUMNS[1], 'message');
});

test('queue reads accept a body row, a legacy message row, or neither', () => {
  assert.equal(readQueueMessage({ body: 'Hello from body' }), 'Hello from body');
  assert.equal(readQueueMessage({ message: 'Hello from message' }), 'Hello from message');
  assert.equal(readQueueMessage({ body: 'body wins', message: 'legacy' }), 'body wins');
  assert.equal(readQueueMessage({ body: null, message: 'legacy' }), 'legacy');
  assert.equal(readQueueMessage({ id: 'row' }), undefined);
  assert.equal(readQueueMessage(null), undefined);
});

test('unknown queue column errors are detected for the fallback write', () => {
  assert.equal(isUnknownColumnError({ code: 'PGRST204', message: "Could not find the 'body' column of 'sms_queue' in the schema cache" }, 'body'), true);
  assert.equal(isUnknownColumnError({ code: 'PGRST204', message: "Could not find the 'message' column of 'sms_queue' in the schema cache" }, 'message'), true);
  assert.equal(isUnknownColumnError({ code: '42703', message: 'column sms_queue.body does not exist' }, 'body'), true);
  assert.equal(isUnknownColumnError({ code: '23505', message: 'duplicate key value violates unique constraint' }, 'body'), false);
  assert.equal(isUnknownColumnError(null, 'body'), false);
});
