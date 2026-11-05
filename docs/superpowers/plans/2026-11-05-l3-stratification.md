# Issue #10 L3 Stratification Implementation Plan

> 阶段记录：下文保留该阶段完成时的状态；当前整体复核、最新测试与提交评审事项见 [#8–#12整体复核](2026-11-05-c-engine-pr-review.md)。

> 在当前会话逐项实施，采用 executing-plans、test-driven-development、requesting-code-review 和 verification-before-completion。用户已确认设计；不执行 commit/push。

**Goal:** 实现 D/Q 四格、可追溯预警、幂等 T4 及核验单证据绑定。

**Architecture:** `engine/l3.js` 做纯计算与快照；`services/stratification.js` 做一致性读取、来源规范化、指纹查重和事务落库；`jobs/stratification.js` 提供任务体/CLI。H2/R1/R2 按 alert_id 读证据。

**Tech Stack:** CommonJS、Node.js 20+、mysql2、MySQL 8.0、Node 内置测试。

## Global Constraints

规则见 `docs/superpowers/specs/2026-11-05-l3-stratification-design.md`。保留既有 #8/#9；不增加依赖、表结构、接口契约、权限或状态机变更；不实现 #11/#12 的动作执行与调度。

## Task 1：纯计算及快照

新建 `server/src/engine/l3.js`、`server/test/l3.test.js`。

接口：`confidenceScore(evidence,referenceAt)`、`classifyScores(d,q)`、`analyzeDay({elderId,targetDate,baseline,current,evidence,cutHour})`。

- [x] 先写失败测试：四格、阈值和取整边界、24 小时衰减、重复/未来/过期信号、Q 封顶、缺数据与冷启动、完整快照和输入隔离。
- [x] 运行测试确认因缺少实现失败，再实现已批准的纯函数。

## Task 2：真实来源、事务与 T4

新建 `server/src/services/stratification.js`、`server/src/jobs/stratification.js`、`server/test/l3.integration.test.js`。

接口：`scanStratification(at)`、`runStratification(at)`。

- [x] 先写真实 MySQL 失败测试；每次使用独立 `yinling_l3_test_...` 数据库。
- [x] 读取 active/monitor 老人、15 天 daily（14 天训练 + 目标日）及五类最新来源；不读取未来输入，不修改 L1/L2 数据或缓存。
- [x] 通过 elder 主键记录锁及事务内指纹查重，验证重跑、并发和新输入行为。
- [x] 同一事务保存 alert 与审计；失败整批回滚；normal/missing 不污染预警计数。
- [x] 验证 CLI 成功概要、失败日志与非零退出码；不注册定时器，不派单/发通知。

## Task 3：证据绑定与回归

修改 `server/src/routes/agent.js`、`server/src/routes/relation.js`、`server/package.json`、`server/README.md`。

- [x] 先用 HTTP 失败用例复现旧核验单/关系人通知显示最新预警的错误，再改为绑定 alert_id；无关联预警不回退到老人最新预警。
- [x] 保留 HTTP 字段与权限；signals 数组兼容现有卡片。
- [x] 运行全部 L1/L2/L3 单测和真实 MySQL 集成，JS 语法、diff 及既有文件哈希检查。
- [x] 独立只读评审，修复有证据的问题并复验。
- [x] 记录改动、验证和边界，关闭临时测试实例，保留本地未提交成果。

## 交付与验证记录（2026-11-05）

状态：#10 本地实现和验证完成。本地工作副本，仍在 `feat/8-l1-signal`，HEAD 为 `d164959dbdd967e388c5447309c982202e24cef6`。没有执行 Git 写操作，保留 #8/#9 原有未提交工作。

| 文件 | 本次变更 |
|---|---|
| `server/src/engine/l3.js` | Q、新鲜度、四格、处置意图和完整快照 |
| `server/src/services/stratification.js` | 一致性读取、规范来源、指纹去重、alert/审计事务 |
| `server/src/jobs/stratification.js` | T4 任务体和命令入口 |
| `server/src/routes/agent.js` | H2 按该核验单的 alert_id 读取证据 |
| `server/src/routes/relation.js` | R1/R2 按通知关联核验单的 alert_id 读取证据 |
| `server/test/l3.test.js` | 13 项纯计算测试 |
| `server/test/l3.integration.test.js` | 18 项真实 HTTP/MySQL 集成测试 |
| `server/package.json` | 增加 T4 命令，测试纳入 L3，依赖未变 |
| `server/README.md` | 规则、运行、输入前提和后续边界 |
| `docs/superpowers/specs/2026-11-05-l3-stratification-design.md` | 用户确认规则及实现澄清 |
| `docs/superpowers/plans/2026-11-05-l3-stratification.md` | 执行、变更和验证记录 |

验证环境：Windows、Node.js `24.18.0`、本机独立 MySQL `8.0.46`。全部使用构造样本及独立 `yinling_l*_test_...` 测试库，没有访问业务库或加载真实个人数据。

- 先失败：12 项初版 L3 单测与 16 项初版集成测试在缺少实现或旧证据绑定逻辑上失败。其中真实 HTTP 已复现旧单显示后来预警、无 alert_id 单据借用最新预警。
- 衔接验证复现：T1 补写 `last_service_at` 导致同一服务事实产生第二条预警。修正为决策输入指纹，同时保留完整原始快照；真实 T1→T4 重跑用例通过。
- 独立评审发现原始按钮/音频值被聚合次数覆盖。新增单测及真实落库用例先失败，再保留原始 `value`、分离 `aggregateValue`；源值变化追加新结果，旧快照保留。
- 最后完整 `npm test`：**36/36 通过**（L1 8 + L2 15 + L3 13）。
- 最后完整 `npm run test:integration`：**46/46 通过**（L1 16 + L2 12 + L3 18），无跳过、失败或取消。
- 合计 **82/82 通过**。包含真实 8 路并发去重、事务失败整批回滚、完整快照、Q/阈值/未来信号边界、H2/R1/R2 绑定及 T4→真实 H2/R2 读取。
- 独立只读复核在修正后重跑 L3 **31/31 通过**，没有剩余必修问题。
- 变更 JS 语法、`git diff --check` 通过；本次开始时的 11 个 L1/L2 实现及测试文件 SHA-256 全部一致。未修改 SQL、docs/04、docs/05、权限或业务状态机。

证据边界：本轮仅证明本地计算及数据库/HTTP 路径，不证明真实用户或异常识别效果。没有另跑 Node.js 20、真机或线上部署。Q 参考时点为目标日结束，不是每次扫描墙钟；对应目标日的 L1 聚合应先完成。#11 尚需执行持久化的派单/补证据意图，#12 尚需自动调度 T4，不能视为 L1→L4 集成闭环。

去重保障限经过本 T4 入口的扫描；没有为 alert 表新增唯一索引，已有演示接口的独立造单不属于本入口去重范围。标准成功回执由 notification 事实兜底；异常历史 raw family_confirmed 不新增迁移或修复，缺 result/非成功值会保守降置信贡献。

所有成果保留为本地未提交文件；没有 push、PR、合并、发布或关闭远程 Issue。
