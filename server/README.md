# server · 后端 API

**负责人：C**

## 待办（W1）

- [ ] `package.json` + Express 骨架
- [ ] 数据库连接池（`mysql2`）
- [ ] JWT 签发与校验中间件
- [ ] `GET /api/health` 健康检查
- [ ] 定时任务骨架（T1 切日 / T2 SLA 扫描 / T3 基线 / T4 分层）

## 约定

- 统一返回 `{ code, data, msg }`
- 所有创建类接口靠 `client_request_id` 唯一键幂等
- SLA 升级必须用 CAS：`UPDATE ... WHERE id = ? AND current_layer = ?`
- 接口清单见 `docs/04-接口列表.md`
