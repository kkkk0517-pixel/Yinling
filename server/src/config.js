/**
 * 统一配置。所有环境变量只在这里读一次，其他地方 require 本模块。
 */
require('dotenv').config();

const DEV_SECRET = 'dev-only-change-me';

const jwtSecret = process.env.JWT_SECRET || DEV_SECRET;

if (jwtSecret === DEV_SECRET) {
  // 不阻塞启动，但必须让人看见
  console.warn('[warn] JWT_SECRET 未设置，正在使用开发默认值。部署前必须改。');
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'yinling',
    connectionLimit: Number(process.env.DB_POOL || 10),
  },

  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES || '7d',
  },

  // 开发环境短信验证码固定值。生产必须接真实短信通道。
  devSmsCode: process.env.DEV_SMS_CODE || '123456',
  isDev: (process.env.NODE_ENV || 'development') !== 'production',
};
