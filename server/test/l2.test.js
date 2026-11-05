const test = require('node:test');
const assert = require('node:assert/strict');
let l2 = {};
try { l2 = require('../src/engine/l2'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function rows14(values = Array.from({ length: 14 }, (_, i) => i + 1)) {
  return values.map((value, i) => ({
    id: i + 1, stat_date: `2026-${i < 11 ? '10-' + (21 + i) : '11-0' + (i - 10)}`,
    calendar_confirmed: 1, app_opens: value, request_count: 0,
    last_open_at: null, last_service_at: null, last_confirm_at: null,
  }));
}
function baseline(rows = rows14()) {
  assert.equal(typeof l2.buildBaseline, 'function', 'L2 baseline calculator is implemented');
  return l2.buildBaseline({ elderId: 1, asOfDate: '2026-11-04', rows, calculatedAt: '2026-11-05 03:00:00', cutHour: 4 });
}
const current = { calendar_confirmed: 1, app_opens: 18, request_count: 0 };

test('median sorts numerically, averages the middle pair, and leaves input unchanged', () => {
  assert.equal(typeof l2.median, 'function');
  const input = [10, 2, 4];
  assert.equal(l2.median(input), 4);
  assert.deepEqual(input, [10, 2, 4]);
  assert.equal(l2.median([9, 1, 4, 2]), 3);
});

test('raw MAD resists an outlier without applying a scaling coefficient', () => {
  assert.equal(typeof l2.mad, 'function');
  const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1000];
  assert.equal(l2.median(input), 7.5);
  assert.equal(l2.mad(input), 3.5);
  assert.equal(l2.mad([2, 2, 2]), 0);
  assert.equal(l2.mad([5]), 0);
});

test('empty statistics have no numeric result and invalid samples are not coerced to zero', () => {
  assert.equal(typeof l2.median, 'function');
  assert.equal(l2.median([]), null);
  assert.equal(l2.mad([]), null);
  for (const values of [[1, null], [1, NaN], [1, Infinity], [1, '2']]) {
    assert.throws(() => l2.median(values));
    assert.throws(() => l2.mad(values));
  }
});

test('fourteen completed days produce exact independent metrics and traceable inputs', () => {
  const rows = rows14();
  const copy = structuredClone(rows);
  const result = baseline(rows.reverse());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.metrics, {
    calendar_confirmed: { median: 1, mad: 0 },
    app_opens: { median: 7.5, mad: 3.5 },
    request_count: { median: 0, mad: 0 },
  });
  assert.equal(result.window.fromDate, '2026-10-21');
  assert.equal(result.window.toDateExclusive, '2026-11-04');
  assert.equal(result.window.startAt, '2026-10-21 04:00:00');
  assert.equal(result.window.endAt, '2026-11-04 04:00:00');
  assert.equal(result.sampleDays, 14);
  assert.equal(result.sources[0].dailyId, 1);
  assert.equal(result.sources[13].app_opens, 14);
  assert.deepEqual(rows, copy.reverse());
});

for (const days of [0, 1, 13]) {
  test(`${days} available days return information insufficient without a numeric deviation`, () => {
    const result = baseline(rows14().slice(0, days));
    assert.equal(result.status, 'insufficient');
    assert.equal(result.message, '信息不足');
    assert.equal(result.metrics, null);
    assert.equal(l2.deviationScore(result, current).dScore, null);
  });
}

test('an older row cannot fill a missing date in the fourteen-day window', () => {
  const rows = rows14().filter(r => r.stat_date !== '2026-10-27');
  rows.push({ ...rows[0], id: 99, stat_date: '2026-10-20' });
  const result = baseline(rows);
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.missingDates, ['2026-10-27']);
});

test('duplicate dates cannot masquerade as fourteen complete days', () => {
  const rows = rows14();
  rows[13] = { ...rows[0], id: 99 };
  assert.equal(baseline(rows).status, 'insufficient');
});

test('current and older out-of-window rows cannot leak into the baseline', () => {
  const rows = rows14();
  rows.push({ ...rows[0], id: 99, stat_date: '2026-11-04', app_opens: 1000 });
  rows.push({ ...rows[0], id: 100, stat_date: '2026-10-20', app_opens: 1000 });
  const result = baseline(rows);
  assert.equal(result.metrics.app_opens.median, 7.5);
  assert.equal(result.sources.length, 14);
});

test('missing, negative, fractional and nonnumeric daily counts yield insufficient information', () => {
  for (const bad of [null, NaN, -1, '5', 1.5]) {
    const rows = rows14();
    rows[2].app_opens = bad;
    const result = baseline(rows);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.metrics, null);
    assert.deepEqual(result.invalidDates, ['2026-10-23']);
  }
});

test('fourteen auto-created zero rows do not invent a personal signal history', () => {
  const rows = rows14(Array(14).fill(0)).map(r => ({ ...r, calendar_confirmed: 0 }));
  assert.equal(baseline(rows).status, 'insufficient');
  for (const row of rows) row.last_service_at = '2026-10-20 04:00:00';
  assert.equal(baseline(rows).status, 'insufficient');
  rows[3].last_service_at = '2026-10-25 10:00:00';
  const result = baseline(rows);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.metrics.app_opens, { median: 0, mad: 0 });
});

test('deviation uses the approved per-metric formula and returns the strongest deviation', () => {
  const result = l2.deviationScore(baseline(), current);
  assert.equal(result.status, 'ready');
  assert.equal(result.dScore, 0.75);
  assert.equal(result.perMetric.calendar_confirmed, 0);
  assert.equal(result.perMetric.app_opens, 0.75);
  assert.equal(result.perMetric.request_count, 0);
  const lower = l2.deviationScore(baseline(), { ...current, app_opens: 0 });
  assert.ok(Math.abs(lower.dScore - 0.6818181818181818) < 1e-12);
});

test('zero MAD produces finite scores and an unchanged observation has D zero', () => {
  const base = baseline(rows14(Array(14).fill(2)));
  const result = l2.deviationScore(base, { ...current, calendar_confirmed: 0, app_opens: 4 });
  assert.ok(Math.abs(result.dScore - 2 / 3) < 1e-12);
  assert.equal(result.perMetric.calendar_confirmed, 0.5);
  assert.equal(l2.deviationScore(base, { ...current, app_opens: 2 }).dScore, 0);
  const extreme = l2.deviationScore(base, { ...current, app_opens: Number.MAX_SAFE_INTEGER });
  assert.ok(Number.isFinite(extreme.dScore) && extreme.dScore >= 0 && extreme.dScore <= 1);
});

test('missing or invalid current metrics do not silently become zero or normal', () => {
  const base = baseline();
  for (const invalid of [null, {}, { ...current, app_opens: null }, { ...current, request_count: -1 }]) {
    const result = l2.deviationScore(base, invalid);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.message, '信息不足');
    assert.equal(result.dScore, null);
  }
});
