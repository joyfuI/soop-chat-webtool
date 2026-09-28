import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overlapsDate } from '../src/broadcastFilters.ts';

test('broadcast ranges overlap the selected local calendar day', () => {
  const range = (first: string, last = first) => ({
    first_collected_at: new Date(first).getTime(),
    last_collected_at: new Date(last).getTime(),
  });
  assert.equal(overlapsDate(range('2026-09-27T12:00:00'), ''), true);
  assert.equal(overlapsDate(range('2026-09-27T12:00:00'), 'invalid'), false);
  assert.equal(overlapsDate(range('2026-09-27T12:00:00'), '2026-09-27'), true);
  assert.equal(
    overlapsDate(
      range('2026-09-25T23:00:00', '2026-09-28T01:00:00'),
      '2026-09-27',
    ),
    true,
  );
  assert.equal(overlapsDate(range('2026-09-26T23:59:59'), '2026-09-27'), false);
  assert.equal(
    overlapsDate(
      range('2026-09-26T23:00:00', '2026-09-27T00:00:00'),
      '2026-09-27',
    ),
    true,
  );
  assert.equal(overlapsDate(range('2026-09-28T00:00:00'), '2026-09-27'), false);
  assert.equal(overlapsDate(range('2026-10-01T00:00:00'), '2026-09-30'), false);

  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(
      overlapsDate(range('2026-03-09T00:15:00-04:00'), '2026-03-08'),
      false,
    );
    assert.equal(
      overlapsDate(range('2026-11-01T23:30:00-05:00'), '2026-11-01'),
      true,
    );
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
