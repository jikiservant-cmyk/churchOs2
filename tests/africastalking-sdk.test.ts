import assert from 'node:assert/strict';
import { test } from 'node:test';
import Africastalking from 'africastalking';

test('Africa\'s Talking SDK exposes the server-side SMS client used by the app', () => {
  const client = Africastalking({ apiKey: 'test-key', username: 'sandbox' });

  assert.equal(typeof client.SMS.send, 'function');
});
