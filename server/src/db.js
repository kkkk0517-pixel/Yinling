/**
 * MySQL 连接池。
 *
 * 约定：业务代码一律通过 query() / queryOne() 访问数据库，
 * 不要在 routes 里直接 new 连接。
 */
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  queueLimit: 0,
  charset: 'utf8mb4',
  // DATETIME 统一按字符串返回，避免时区二次转换
  dateStrings: true,
  timezone: '+08:00',
});

/** 执行查询，返回 rows 数组 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** 查询单条，没有则返回 null */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 执行写操作，返回 ResultSetHeader */
async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** 健康检查用：能 ping 通就算活 */
async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, queryOne, execute, ping };
