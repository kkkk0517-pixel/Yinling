# server · 后端 API

**负责人：C / PM**

## 目录

```
server/
├── src/                 真后端（Express）
│   ├── index.js         入口
│   ├── app.js           中间件与路由装配
│   ├── config.js        环境变量（只在这里读一次）
│   ├── db.js            MySQL 连接池
│   ├── middleware/
│   │   ├── auth.js      requireAuth / requireFunction
│   │   └── error.js     404 与 500 兜底
│   ├── routes/
│   │   ├── health.js    GET /api/health
│   │   └── auth.js      A1 / A2 / A3
│   └── utils/
│       ├── jwt.js       签发与校验
│       └── response.js  ok / fail
├── mock/                临时 mock，A/B 联调用，真后端接上后删除
└── .env.example
```

## 启动

```bash
cd server
npm install
cp .env.example .env      # 改 DB_PASSWORD 和 JWT_SECRET
npm run dev               # http://localhost:3000
```

数据库还没建？先跑 `sql/schema.sql` 和 `sql/seed.sql`（见仓库根 README）。

**只想联调前端**，不想装数据库：

```bash
npm run mock              # 45 个接口全可用，零依赖
```

## 已实现

| 编号 | 接口 | 状态 |
|---|---|---|
| A1 | `POST /api/auth/sms-code` | ✅ 开发环境固定返回 `123456` |
| A2 | `POST /api/auth/login` | ✅ 查库 + 签 JWT，返回 `person / functions / elders` |
| A3 | `GET /api/auth/me` | ✅ 需登录 |
| — | `GET /api/health` | ✅ 带数据库连通性检查 |

`A4` 邀请码、`A5` 绑定归 `#3`，依赖 `invite_code` 的写入逻辑。

## 约定

- 统一返回 `{ code, data, msg }`，`code = 0` 为成功
- 错误码与 HTTP status 一致：401 / 403 / 404 / 409 / 422 / 500
- 所有创建类接口靠 `clientRequestId` 唯一键幂等，**不靠代码 if 判断**
- SLA 升级必须用 CAS：`UPDATE ... WHERE id = ? AND current_layer = ?`
- 接口清单见 `docs/04-接口列表.md`

## 两条硬规则

**① 权限判断必须在服务端。** 前端隐藏按钮或路由守卫不算权限控制。

```js
const { requireAuth, requireFunction } = require('../middleware/auth');

// 只要登录
router.get('/xxx', requireAuth, handler);

// 必须是管理员或承办人
router.get('/xxx', requireAuth, requireFunction('admin', 'agent'), handler);
```

**② token 无效一律 401，不要漏成 500。**

`requireAuth` 已经处理了：缺 token、格式错、过期、签名错，全部 401，只有真正的服务端异常才 500。

## 下一步

- `#3` 把 49 个接口全部挂上路由
- 定时任务 T1–T4（`src/jobs/`）
- L1–L4 引擎（`src/engine/`）
