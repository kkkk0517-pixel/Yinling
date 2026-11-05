const test = require('node:test');
const assert = require('node:assert/strict');

let dates = {};
try {
  dates = require('../src/utils/signal-day');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

for (const [at, hour, expected] of [
  ['2026-11-04 03:59:59', 4, '2026-11-03'],
  ['2026-11-04 04:00:00', 4, '2026-11-04'],
  ['2026-03-01 00:15:00', 4, '2026-02-28'],
  ['2027-01-01 03:00:00', 4, '2026-12-31'],
  ['2026-11-03T20:00:00Z', 4, '2026-11-04'],
  ['2026-11-04 05:59:59', 6, '2026-11-03'],
]) {
  test(`${at} with cut hour ${hour} belongs to ${expected}`, () => {
    assert.equal(typeof dates.signalDay, 'function', 'business-day helper is implemented');
    assert.equal(dates.signalDay(at, hour), expected);
  });
}

test('day window includes the cut time and excludes the next cut time', () => {
  assert.equal(typeof dates.dayRange, 'function');
  assert.deepEqual(dates.dayRange('2026-12-31', 4), {
    start: '2026-12-31 04:00:00', end: '2027-01-01 04:00:00',
  });
});

test('invalid dates and cut hours are rejected instead of silently changing the window', () => {
  assert.equal(typeof dates.signalDay, 'function');
  for (const hour of [-1, 24, 4.5, NaN]) assert.throws(() => dates.signalDay('2026-11-04 04:00:00', hour));
  assert.throws(() => dates.signalDay('not-a-date', 4));
  assert.throws(() => dates.dayRange('2026-02-30', 4));
});
