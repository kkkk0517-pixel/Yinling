# 银铃 · Copilot 指令

完整规则见仓库根目录 `AGENTS.md`。以下五条是底线：

1. **人决定 WHAT，AI 决定 HOW。** 不得自行新增功能、字段、页面或接口。
2. **接口契约以 `docs/04-接口列表.md` 为准。** 改了接口，同一个 PR 内更新它。
3. **表结构以 `docs/05-数据表DDL.md` 为准。** 改了表，同一个 PR 内更新它。
4. **暂缓清单不得实现。** 见 `docs/02-系统端功能规格.md` 第 0.1 节。
5. **权限判断必须在服务端。** 前端隐藏按钮或路由守卫不算权限控制。

## 技术栈

| 层 | 技术 |
|---|---|
| 老人端 / 关系人端 | 微信原生小程序（一个包，按 `functions` 分流） |
| 处置端 / 管理端 | Vue 3 + Element Plus（Vite，`/agent` 与 `/admin` 两个路由） |
| 后端 | Node.js + Express + mysql2 |
| 数据库 | MySQL 8.0 / utf8mb4 |

## 目录

```
miniprogram/   A 负责
web/           B 负责
server/        C / PM 负责
sql/           PM 负责
docs/          唯一事实来源，PM 守门
```

## 两条不能破的实现约束

- 所有「创建类」接口带 `clientRequestId`，靠唯一键幂等，不靠代码 if 判断。
- SLA 升级用 CAS（`UPDATE ... WHERE id = ? AND current_layer = ?`），先查后改会重复升级。
