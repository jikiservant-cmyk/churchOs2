import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPublicGivingGateError,
  PUBLIC_GIVING_DISABLED_MESSAGE,
  PUBLIC_GIVING_ENABLED,
} from '../lib/public-giving.ts';

test('public giving remains disabled until atomic donation settlement is implemented', () => {
  assert.equal(PUBLIC_GIVING_ENABLED, false);
  assert.deepEqual(getPublicGivingGateError(), { error: PUBLIC_GIVING_DISABLED_MESSAGE });
  assert.equal(PUBLIC_GIVING_DISABLED_MESSAGE, 'Online giving is not available yet.');
});
