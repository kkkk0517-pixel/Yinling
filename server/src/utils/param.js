/**
 * 社区参数读取。
 *
 * 所有时限、开关都从 param 表读，不要硬编码在业务代码里
 * （见 AGENTS.md 第 6 节：promise 由服务端按配置生成，前端写死就假了）。
 */
const { query } = require('../db');

const COMMUNITY_ID = 1;

/** 一次取出全部参数，返回普通对象 */
async function loadParams() {
  const rows = await query('SELECT k, v FROM param WHERE community_id = ?', [COMMUNITY_ID]);
  const out = {};
  for (const r of rows) out[r.k] = r.v;
  return out;
}

/** 取单个参数，带默认值和数字转换 */
async function getParam(key, fallback) {
  const rows = await query('SELECT v FROM param WHERE community_id = ? AND k = ?', [COMMUNITY_ID, key]);
  if (!rows.length) return fallback;
  const raw = rows[0].v;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

/** 写参数（只允许已存在的 key，白名单在调用方控制） */
async function setParam(key, value) {
  await query(
    `INSERT INTO param (community_id, k, v) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [COMMUNITY_ID, key, String(value)]
  );
}

/** 允许通过 M8 修改的白名单 */
const WRITABLE_KEYS = [
  'layer_count',
  'layer1_wait_min',
  'layer2_wait_min',
  'route_mode',
  'merge_window_sec',
  'day_cut_hour',
  'baseline_days',
  'time_scale',
  'service_pool_wait_min',
  'bill_limit',
  'role_label_agent',
];

module.exports = { loadParams, getParam, setParam, WRITABLE_KEYS, COMMUNITY_ID };
