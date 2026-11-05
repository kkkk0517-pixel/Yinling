/** L1 统计日：固定按 UTC+8 解释数据库时间，窗口左闭右开。 */
const HOUR_MS = 60 * 60 * 1000;

function checkHour(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('day_cut_hour 必须为 0–23 的整数');
}

function instant(input) {
  const wallTime = typeof input === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(input);
  const value = wallTime ? input.replace(' ', 'T') + '+08:00' : input;
  const date = input instanceof Date ? input : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('无效的信号时间');
  if (wallTime && new Date(date.getTime() + 8 * HOUR_MS).toISOString().slice(0, 19) !== input.replace(' ', 'T')) {
    throw new RangeError('无效的信号时间');
  }
  return date.getTime();
}

function signalTime(at) {
  return new Date(instant(at) + 8 * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function signalDay(at, cutHour = 4) {
  checkHour(cutHour);
  return new Date(instant(at) + (8 - cutHour) * HOUR_MS).toISOString().slice(0, 10);
}

function dayRange(date, cutHour = 4) {
  checkHour(cutHour);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('统计日格式必须为 YYYY-MM-DD');
  const midnight = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) throw new RangeError('无效的统计日');
  const next = new Date(midnight.getTime() + 24 * HOUR_MS).toISOString().slice(0, 10);
  const time = String(cutHour).padStart(2, '0') + ':00:00';
  return { start: date + ' ' + time, end: next + ' ' + time };
}

module.exports = { signalDay, dayRange, signalTime };
