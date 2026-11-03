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

**45 个 HTTP 接口全部落地**，全部连真库。

| 组 | 文件 | 数量 | 编号 |
|---|---|---|---|
| 认证与绑定 | `routes/auth.js` | 5 | A1–A5 |
| 老人端 | `routes/elder.js` | 7 | E1–E7 |
| 关系人端 | `routes/relation.js` | 9 | R1–R9 |
| 处置端 | `routes/agent.js` | 10 | H1–H10 |
| 管理端 | `routes/admin.js` | 11 | M1–M11 |
| 调试与演示 | `routes/demo.js` | 3 | D1–D3 |
| 健康检查 | `routes/health.js` | 1 | `GET /api/health` |

定时任务 T1–T4 不是 HTTP，归 `#12`。

### 几条已经落地的硬规则

- **只有主责回执才停计时**（R3）：知会人点了不清 `sla_deadline`
- **耗时和无效核查由服务端算**（H4）：`duration_min` 取第一条 action 事件到现在，`is_invalid_check` 由 `result_code` 判定，前端传不了
- **promise 按 param 生成**（E5）：改时限后话术自动变
- **30 秒内同类单合并**（E5）：`merge_window_sec` 控制
- **M6 整体覆盖式保存**：先清后建，避免「删了主责没删关系」的脏数据
- **M8 只改白名单 key**：不在 `WRITABLE_KEYS` 里的一律 422
- **D1 真读 `sql/seed.sql`**：不是硬编码一份假数据

### 尚未实现

| 项 | 归属 |
|---|---|
| 录音文件真实上传（E4 目前只登记元数据） | `#13` |
| L1–L4 引擎、定时任务 | `#8`–`#12` |
| SLA 自动升级（R3 只做「停计时」，升级靠 T2） | `#11` `#12` |

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
