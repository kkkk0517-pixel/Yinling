/** L2 纯计算。规则由用户于 2026-11-05 确认；不判断是否异常。 */
const { dayRange, signalTime } = require('../utils/signal-day');

const BASELINE_DAYS = 14;
const VERSION = 'l2-median-mad-v1';
const METRICS = ['calendar_confirmed', 'app_opens', 'request_count'];

function median(values) {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new TypeError('中位数样本必须为有限数值数组');
  }
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
}

function mad(values) {
  const center = median(values);
  return center === null ? null : median(values.map(value => Math.abs(value - center)));
}

function validMetrics(row) {
  return !!row && (row.calendar_confirmed === 0 || row.calendar_confirmed === 1)
    && ['app_opens', 'request_count'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0);
}

function shiftDate(date, days) {
  return new Date(new Date(date + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}

function buildBaseline({ elderId, asOfDate, rows = [], calculatedAt, cutHour = 4 }) {
  const endAt = dayRange(asOfDate, cutHour).start;
  const fromDate = shiftDate(asOfDate, -BASELINE_DAYS);
  const startAt = dayRange(fromDate, cutHour).start;
  const dates = Array.from({ length: BASELINE_DAYS }, (_, i) => shiftDate(fromDate, i));
  const selected = rows.filter(row => row.stat_date >= fromDate && row.stat_date < asOfDate)
    .sort((a, b) => a.stat_date.localeCompare(b.stat_date));
  const byDate = new Map();
  const invalid = new Set();
  for (const row of selected) {
    if (byDate.has(row.stat_date) || !validMetrics(row)) invalid.add(row.stat_date);
    byDate.set(row.stat_date, row);
  }
  const missingDates = dates.filter(date => !byDate.has(date));
  const hasSignalHistory = selected.some(row => {
    if (validMetrics(row) && METRICS.some(key => row[key] > 0)) return true;
    return ['last_open_at', 'last_service_at', 'last_confirm_at'].some(key => {
      if (!row[key]) return false;
      try { const time = signalTime(row[key]); return time >= startAt && time < endAt; }
      catch { return false; }
    });
  });
  const sampleDays = dates.filter(date => byDate.has(date) && !invalid.has(date)).length;
  const ready = sampleDays === BASELINE_DAYS && invalid.size === 0 && hasSignalHistory;
  const metrics = ready ? Object.fromEntries(METRICS.map(key => {
    const values = dates.map(date => byDate.get(date)[key]);
    return [key, { median: median(values), mad: mad(values) }];
  })) : null;
  return {
    version: VERSION, elderId, asOfDate, calculatedAt: signalTime(calculatedAt),
    window: { days: BASELINE_DAYS, fromDate, toDateExclusive: asOfDate, startAt, endAt, cutHour },
    status: ready ? 'ready' : 'insufficient', message: ready ? '基线就绪' : '信息不足',
    sampleDays, missingDates, invalidDates: [...invalid].sort(), hasSignalHistory, metrics,
    sources: selected.map(row => ({
      dailyId: row.id, stat_date: row.stat_date,
      calendar_confirmed: row.calendar_confirmed, app_opens: row.app_opens, request_count: row.request_count,
      last_open_at: row.last_open_at ?? null, last_service_at: row.last_service_at ?? null,
      last_confirm_at: row.last_confirm_at ?? null,
    })),
  };
}

function deviationScore(baseline, current) {
  const insufficient = { status: 'insufficient', message: '信息不足', dScore: null, perMetric: null };
  if (baseline?.status !== 'ready' || !validMetrics(current)) return insufficient;
  const perMetric = {};
  for (const key of METRICS) {
    const stats = baseline.metrics?.[key];
    if (!stats || !Number.isFinite(stats.median) || stats.median < 0 || !Number.isFinite(stats.mad) || stats.mad < 0) {
      return insufficient;
    }
    const delta = Math.abs(current[key] - stats.median);
    perMetric[key] = delta / (delta + Math.max(stats.mad, 1));
  }
  return { status: 'ready', message: '偏离度已计算', dScore: Math.max(...Object.values(perMetric)), perMetric };
}

module.exports = { BASELINE_DAYS, median, mad, buildBaseline, deviationScore };
