/**
 * 时间工具。全项目统一 'YYYY-MM-DD HH:mm:ss'（UTC+8，服务器本地时区）。
 * 见 docs/04-接口列表.md「零、通用约定」。
 */
const pad = (n) => String(n).padStart(2, '0');

function formatDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function now() {
  return formatDateTime(new Date());
}

/** 现在 + n 分钟 */
function plusMin(min) {
  return formatDateTime(new Date(Date.now() + min * 60000));
}

/** 两个时刻之间的分钟差，b 缺省为现在 */
function diffMinutes(from, to) {
  const a = new Date(from).getTime();
  const b = to ? new Date(to).getTime() : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

/** 距离某时刻还剩多少秒，过期返回负数 */
function secondsUntil(target) {
  if (!target) return null;
  const t = new Date(target).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 1000);
}

/** 今天 00:00:00 */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return formatDateTime(d);
}

module.exports = { formatDateTime, now, plusMin, diffMinutes, secondsUntil, todayStart };
