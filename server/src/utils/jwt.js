/**
 * JWT 签发与校验。
 *
 * payload 只放最小必要信息：personId / functions。
 * 权限判断一律以数据库为准的场合（如改档案），不要只信 payload 里的 functions。
 */
const jwt = require('jsonwebtoken');
const config = require('../config');

function sign(person) {
  return jwt.sign(
    {
      sub: person.id,
      functions: person.functions,
      name: person.name,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function verify(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = { sign, verify };
