/**
 * 时间工具。全项目统一 'YYYY-MM-DD HH:mm:ss'（UTC+8，服务器本地时区）。
 * 见 docs/04-接口列表.md「零、通用约定」。
 */
const { signalTime } = require('./signal-day');
const { businessClock } = require('./business-clock');

function formatDateTime(input) {
  try { return signalTime(input); } catch { return null; }
}

function now() {
  return businessClock.now();
}

/** 现在 + n 分钟 */
function plusMin(min) {
  return formatDateTime(new Date(businessClock.nowMs() + min * 60000));
}

/** 两个时刻之间的分钟差，b 缺省为现在 */
function diffMinutes(from, to) {
  const a = new Date(String(formatDateTime(from)).replace(' ', 'T') + '+08:00').getTime();
  const b = to ? new Date(String(formatDateTime(to)).replace(' ', 'T') + '+08:00').getTime() : businessClock.nowMs();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

/** 距离某时刻还剩多少秒，过期返回负数 */
function secondsUntil(target) {
  if (!target) return null;
  const t = new Date(String(formatDateTime(target)).replace(' ', 'T') + '+08:00').getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - businessClock.nowMs()) / 1000);
}

/** 今天 00:00:00 */
function todayStart() {
  return now().slice(0, 10) + ' 00:00:00';
}

module.exports = { formatDateTime, now, plusMin, diffMinutes, secondsUntil, todayStart };
