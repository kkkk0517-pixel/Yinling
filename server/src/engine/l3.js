/** L3 项目规则，2026-11-05 经用户确认。D 与 Q 分开计算，不判断人是否异常。 */
const { deviationScore } = require('./l2');
const { signalTime, dayRange } = require('../utils/signal-day');

const POLICY = Object.freeze({
  version: 'l3-dq-v1', dHigh: 0.5, qHigh: 0.5, freshnessHours: 24,
  weights: Object.freeze({ calendar_confirmed: 0.6, app_open: 0.1, button_pressed: 0.2, service_completed: 0.7, family_confirmed: 0.6 }),
});
const LABELS = { calendar_confirmed: '日历确认', app_open: '应用打开', button_pressed: '四键请求', service_completed: '服务完成', family_confirmed: '关系人成功回执' };
const PATHS = { strong: 'dispatch_verify', insufficient: 'request_evidence', normal: 'no_intervention', missing: 'wait_next_scan' };
const MESSAGES = { strong: '强证据偏离', insufficient: '证据不足，需补证据', normal: '基线内波动', missing: '信号缺失，等待下一轮' };
const roundScore = value => Math.round(value * 1000) / 1000;
const milliseconds = value => new Date(signalTime(value).replace(' ', 'T') + '+08:00').getTime();

function classifyScores(d, q) {
  if (![d, q].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
    return { status: 'insufficient', message: '信息不足', cell: null, dScore: null, qScore: null, routeIntent: 'wait_next_scan' };
  }
  const dScore = roundScore(d), qScore = roundScore(q);
  const cell = dScore >= POLICY.dHigh
    ? (qScore >= POLICY.qHigh ? 'strong' : 'insufficient')
    : (qScore >= POLICY.qHigh ? 'normal' : 'missing');
  return { status: 'ready', message: MESSAGES[cell], cell, dScore, qScore, routeIntent: PATHS[cell] };
}

function confidenceScore(evidence, referenceAt) {
  const reference = milliseconds(referenceAt);
  const latest = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || !Object.hasOwn(POLICY.weights, item.type) || !item.at) continue;
    let timestamp;
    try { timestamp = signalTime(item.at); } catch { continue; }
    if (milliseconds(timestamp) >= reference) continue;
    const old = latest.get(item.type);
    const sourceId=Number(item.source?.id||0),oldId=Number(old?.source?.id||0);
    // 同秒按规范来源稳定选择；同一来源的后置业务事实覆盖旧补采值。
    const newerSource=sourceId>oldId||(sourceId===oldId&&String(item.source?.table||'')>=String(old?.source?.table||''));
    if (!old || timestamp > old.at || (timestamp === old.at && newerSource)) {
      latest.set(item.type, { ...item, at: timestamp });
    }
  }
  const signals = Object.entries(POLICY.weights).map(([type, weight]) => {
    const item = latest.get(type);
    const freshness = item ? Math.max(0, 1 - (reference - milliseconds(item.at)) / 86400000) : 0;
    return {
      signal: type, value: item ? structuredClone(item.value ?? null) : null,
      source: item ? structuredClone(item.source ?? null) : null, at: item?.at ?? null,
      weight, freshness, contribution: weight * freshness,
      note: item ? `${LABELS[type]}：${item.at}，本轮新鲜度 ${Math.round(freshness * 100)}%` : `没有可用的${LABELS[type]}记录`,
    };
  });
  return { qScore: roundScore(Math.min(1, signals.reduce((sum, signal) => sum + signal.contribution, 0))), signals };
}

function analyzeDay({ elderId, targetDate, baseline, current, evidence, cutHour = 4 }) {
  const referenceAt = dayRange(targetDate, cutHour).end;
  const confidence = confidenceScore(evidence, referenceAt);
  const deviation = deviationScore(baseline, current);
  const result = classifyScores(deviation.dScore, confidence.qScore);
  const signals = confidence.signals;
  const metrics = { calendar_confirmed: 'calendar_confirmed', app_open: 'app_opens', button_pressed: 'request_count' };
  for (const signal of signals) {
    if (Object.hasOwn(metrics, signal.signal)) {
      signal.aggregateValue = current?.[metrics[signal.signal]] ?? null;
      const display = signal.aggregateValue === null ? '数据缺失' : String(signal.aggregateValue);
      signal.note = `${targetDate} ${LABELS[signal.signal]}：${display}；${signal.note}`;
    }
  }
  signals[0].context = {
    version: POLICY.version, elderId, targetDate, referenceAt,
    policy: structuredClone(POLICY), baseline: structuredClone(baseline ?? null), current: structuredClone(current ?? null),
    perMetricD: structuredClone(deviation.perMetric), status: result.status,
    dScore: result.dScore, qScore: result.qScore, cell: result.cell, routeIntent: result.routeIntent,
  };
  return { ...result, signalSnapshot: signals };
}

module.exports = { POLICY, classifyScores, confidenceScore, analyzeDay };
