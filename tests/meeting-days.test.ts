import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ISO_WEEKDAYS, normalizeMeetingDays } from '../lib/meeting-days.ts';

describe('church meeting-day settings', () => {
  it('uses ISO weekdays with Monday first and Sunday last', () => {
    assert.deepEqual(ISO_WEEKDAYS, [1, 2, 3, 4, 5, 6, 7]);
  });

  it('sorts and deduplicates a valid selection for storage', () => {
    assert.deepEqual(normalizeMeetingDays([7, 2, 2, 1]), [1, 2, 7]);
  });

  it('rejects empty selections because the database requires one or more days', () => {
    assert.equal(normalizeMeetingDays([]), null);
  });

  it('rejects invalid weekdays and non-integer values', () => {
    assert.equal(normalizeMeetingDays([0, 2]), null);
    assert.equal(normalizeMeetingDays([1, 8]), null);
    assert.equal(normalizeMeetingDays([1, 2.5]), null);
    assert.equal(normalizeMeetingDays(['1', 2]), null);
    assert.equal(normalizeMeetingDays(null), null);
  });
});
