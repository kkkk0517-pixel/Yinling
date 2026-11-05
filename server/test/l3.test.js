const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBaseline } = require('../src/engine/l2');
let l3 = {};
try { l3 = require('../src/engine/l3'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const referenceAt = '2026-11-05 04:00:00';
function event(type, at, id = 1) { return { type, at, source: { table: 'signal_event', id }, value: 1 }; }
function baseline() {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: i + 1, stat_date: new Date(Date.UTC(2026, 9, 21 + i)).toISOString().slice(0, 10),
    calendar_confirmed: 1, app_opens: 2, request_count: 0,
  }));
  return buildBaseline({ elderId: 1, asOfDate: '2026-11-04', rows, calculatedAt: referenceAt, cutHour: 4 });
}
function analyze(extra = {}) {
  assert.equal(typeof l3.analyzeDay, 'function', 'L3 analyzer is implemented');
  return l3.analyzeDay({ elderId: 1, targetDate: '2026-11-04', baseline: baseline(),
    current: { id: 15, stat_date: '2026-11-04', calendar_confirmed: 0, app_opens: 0, request_count: 0 },
    evidence: [event('service_completed', '2026-11-05 03:00:00')], ...extra });
}

for (const [d, q, cell, routeIntent] of [
  [0.5, 0.5, 'strong', 'dispatch_verify'],
  [0.8, 0.1, 'insufficient', 'request_evidence'],
  [0.1, 0.8, 'normal', 'no_intervention'],
  [0.1, 0.1, 'missing', 'wait_next_scan'],
]) {
  test(`${cell} has its own disposition path`, () => {
    assert.equal(typeof l3.classifyScores, 'function');
    const result = l3.classifyScores(d, q);
    assert.equal(result.cell, cell);
    assert.equal(result.routeIntent, routeIntent);
  });
}

test('classification agrees with persisted three-decimal scores on a rounding boundary', () => {
  assert.equal(typeof l3.classifyScores, 'function');
  const low = l3.classifyScores(0.4994, 0.8);
  assert.equal(low.dScore, 0.499);
  assert.equal(low.cell, 'normal');
  const high = l3.classifyScores(0.4996, 0.8);
  assert.equal(high.dScore, 0.5);
  assert.equal(high.cell, 'strong');
});

test('unknown or invalid scores do not become a low-risk grid cell', () => {
  assert.equal(typeof l3.classifyScores, 'function');
  for (const [d, q] of [[null, 1], [NaN, 1], [0, Infinity], [-0.1, 1], [1, 1.1], ['0.8', 1]]) {
    const result = l3.classifyScores(d, q);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.cell, null);
    assert.equal(result.dScore, null);
  }
});

test('freshness decays linearly and each source keeps its approved weight', () => {
  assert.equal(typeof l3.confidenceScore, 'function');
  const result = l3.confidenceScore([event('calendar_confirmed', '2026-11-04 16:00:00')], referenceAt);
  assert.equal(result.qScore, 0.3);
  const signal = result.signals.find(s => s.signal === 'calendar_confirmed');
  assert.equal(signal.weight, 0.6);
  assert.equal(signal.freshness, 0.5);
  assert.equal(signal.contribution, 0.3);
});

test('repeated app opens do not inflate Q beyond the single latest source', () => {
  assert.equal(typeof l3.confidenceScore, 'function');
  const evidence = Array.from({ length: 100 }, (_, i) => event('app_open', '2026-11-05 03:00:00', i + 1));
  const result = l3.confidenceScore(evidence, referenceAt);
  assert.equal(result.qScore, 0.096);
  assert.equal(result.signals.find(s => s.signal === 'app_open').source.id, 100);
});

test('future, exact-cut, expired and malformed evidence cannot raise Q', () => {
  assert.equal(typeof l3.confidenceScore, 'function');
  const result = l3.confidenceScore([
    event('calendar_confirmed', '2026-11-05 04:00:00'),
    event('service_completed', '2026-11-05 05:00:00'),
    event('family_confirmed', '2026-11-04 04:00:00'),
    event('button_pressed', 'invalid'),
    event('unrecognized', '2026-11-05 03:00:00'),
  ], referenceAt);
  assert.equal(result.qScore, 0);
});

test('multiple source contributions are capped at one', () => {
  assert.equal(typeof l3.confidenceScore, 'function');
  assert.equal(l3.confidenceScore([
    event('calendar_confirmed', '2026-11-05 03:59:59'),
    event('service_completed', '2026-11-05 03:59:59'),
    event('family_confirmed', '2026-11-05 03:59:59'),
  ], referenceAt).qScore, 1);
});

test('D and Q remain separate and snapshot holds the complete basis and route intent', () => {
  const base = baseline();
  const result = analyze({ baseline: base });
  assert.equal(result.dScore, 0.667);
  assert.equal(result.qScore, 0.671);
  assert.equal(result.cell, 'strong');
  assert.equal(result.routeIntent, 'dispatch_verify');
  assert.equal(result.signalSnapshot.length, 5);
  const context = result.signalSnapshot[0].context;
  assert.deepEqual(context.baseline, base);
  assert.equal(context.baseline.sources.length, 14);
  assert.equal(context.current.id, 15);
  assert.equal(context.targetDate, '2026-11-04');
  assert.equal(context.referenceAt, referenceAt);
  assert.equal(context.routeIntent, 'dispatch_verify');
  for (const signal of result.signalSnapshot) {
    assert.equal(typeof signal.note, 'string');
    assert.equal(typeof signal.weight, 'number');
    assert.equal(typeof signal.freshness, 'number');
  }
  context.baseline.metrics.app_opens.median = 999;
  assert.equal(base.metrics.app_opens.median, 2);
});

test('cold baseline, missing target row and invalid current values remain information insufficient', () => {
  for (const extra of [
    { baseline: { status: 'insufficient', message: '信息不足' } },
    { current: null },
    { current: { calendar_confirmed: 0, app_opens: null, request_count: 0 } },
  ]) {
    const result = analyze(extra);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.cell, null);
    assert.equal(result.dScore, null);
    assert.equal(result.routeIntent, 'wait_next_scan');
  }
});

test('original button and audio evidence is preserved separately from aggregate request counts', () => {
  const raw = { type: 'button_pressed', at: '2026-11-04 20:00:00', source: { table: 'service_order', id: 99 },
    value: { keyType: 'unwell', hasAudio: true, audioDuration: 20 } };
  const result = analyze({ current: { id: 15, stat_date: '2026-11-04', calendar_confirmed: 0, app_opens: 0, request_count: 2 }, evidence: [raw] });
  const signal = result.signalSnapshot.find(s => s.signal === 'button_pressed');
  assert.deepEqual(signal.value, { keyType: 'unwell', hasAudio: true, audioDuration: 20 });
  assert.equal(signal.aggregateValue, 2);
  assert.equal(signal.source.id, 99);
  signal.value.audioDuration = 999;
  assert.equal(raw.value.audioDuration, 20);
});
