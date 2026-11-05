# server · 后端 API

**负责人：C / PM**

## 目录

```
server/
├── src/                 后端（Express）
│   ├── index.js         入口
│   ├── app.js           中间件与路由装配
│   ├── config.js        环境变量（只在这里读一次）
│   ├── db.js            MySQL 连接池
│   ├── middleware/
│   │   ├── auth.js      requireAuth / requireFunction
│   │   └── error.js     404 与 500 兜底
│   ├── routes/
│   │   ├── health.js    GET /api/health
│   │   ├── auth.js      A1–A5
│   │   ├── elder.js     E1–E7
│   │   ├── relation.js  R1–R10
│   │   ├── agent.js     H1–H10
│   │   ├── admin.js     M1–M11
│   │   └── demo.js      D1–D3
│   └── utils/
│       ├── jwt.js       签发与校验
│       ├── param.js     社区参数读写
│       ├── response.js  ok / fail
│       └── time.js      时间格式化
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

## 已实现

当前注册 **46 个业务 HTTP 接口**，另有健康检查；各功能的验证范围见下文与本地交付记录。

| 组 | 文件 | 数量 | 编号 |
|---|---|---|---|
| 认证与绑定 | `routes/auth.js` | 5 | A1–A5 |
| 老人端 | `routes/elder.js` | 7 | E1–E7 |
| 关系人端 | `routes/relation.js` | 10 | R1–R10 |
| 处置端 | `routes/agent.js` | 10 | H1–H10 |
| 管理端 | `routes/admin.js` | 11 | M1–M11 |
| 调试与演示 | `routes/demo.js` | 3 | D1–D3 |
| 健康检查 | `routes/health.js` | 1 | `GET /api/health` |

定时任务 T1–T4 不是 HTTP，`#12` 已接入服务生命周期，默认随服务启动；配置和健康口径见下文。

### L1 采集与每日聚合（#8）

- E1 打开首页写入 `app_open`；E2 确认日历写入 `calendar_confirmed`。打开只算弱活动，确认不增加打开次数，也不冒充家属确认。
- E2 的 `clientRequestId` 按现有契约必须为 UUID v4。事件依赖 `signal_event.uk_client` 幂等；同一请求重试返回最初的 `confirmedAt`，跨日重试不会确认新的一天。
- 业务日按 UTC+8、`param.day_cut_hour`（默认 4）归属，范围是当天 04:00（含）到次日 04:00（不含）。E1/E2 使用同一业务日。
- “已攒页数”只统计已经确认的日期，空白汇总行不加页，连续天数遇到缺失日期就中断；累计页数和连续天数均不截断为 60 天。
- `src/jobs/day-cut.js` 提供 T1 任务体：重算刚结束的一天，并创建/重算当日行；当日已有确认会被保留。事件写入与重算通过每日行锁串行，失败回滚、重跑不累加。
- T1 从既有业务记录补采四键请求（`service_order.created_at`，含音频有无/时长）、已完成服务（`done_at`）、关系人成功回执（`ok_visited` / `ok_called`）。各条记录保留来源表及主键，依靠稳定事件键防止重复；`unreachable` 不更新最近确认时间。
- `request_count` 按已创建的服务单计数；合并到已有单的按钮操作没有独立持久化事实，不能从现有数据还原为多次请求。音频仅采集现有元数据，真实上传仍属于 #13。
- 服务和回执在 T1 执行时纳入汇总，最近接触时间可跨日延续；未接入外部水电表、语音情绪等后续能力。

本地数据库配置好后，在 `server/` 执行：

```bash
npm run job:day-cut
```

CLI 任务成功输出 `[T1] 切日完成` 和处理日期/老人数；失败输出 `[T1] 切日失败` 并以非零状态退出。服务中的调度器直接调用 `runDayCut()`，按任务执行和留档结果更新健康。

**重算依据是原始事件和上述业务记录。** 仅存在于 `signal_daily`、没有原始来源的演示汇总值不会被当作真实事件保留；`sql/seed.sql` 的演示数据后续需在 #25 对齐来源。

### L1 测试

`npm test` 运行无数据库的统计日测试。`npm run test:integration` 运行真实 HTTP + MySQL 8.0 测试：只连接本机 `127.0.0.1:13308` 的独立测试实例，使用无密码 root；可通过 `L1_TEST_MYSQL_PORT` 改测试端口。不要把测试端口指向业务数据库实例。

独立测试实例示例（已安装并启动 Docker 时）：

```bash
docker run -d --rm --name yinling-l1-test -p 127.0.0.1:13308:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.0 --default-time-zone=+08:00
# 等待 mysqladmin ping 成功后运行测试
docker exec yinling-l1-test mysqladmin ping --silent
npm test
npm run test:integration
docker stop yinling-l1-test
```

L1 集成测试每次新建 `yinling_l1_test_...` 数据库，结束后删除自身创建的数据库，不执行建库脚本开头的 `DROP DATABASE yinling`，不加载演示种子数据。覆盖重复/并发提交、跨日重放、事件与重算竞争、事务回滚及业务来源重复采集。#12 的 D1 用例另在自己的 `yinling_jobs_server_test_...` 库中加载种子，验证只重置配置指定的测试库。

### L2 个体基线与 T3（#9）

在 `server/` 执行 `npm run job:baseline`，可手动计算并保存一批基线。服务进程默认在 UTC+8 03:00 自动触发，也在启动时补跑当前周期；没有新增基线 HTTP 接口。

- 每人取当前统计日之前 14 个完整统计日。例如 11 月 5 日 03:00 尚处于 11 月 4 日统计日，窗口为 10 月 21 日 04:00 至 11 月 4 日 04:00，不纳入仍未结束的 11 月 4 日。
- 对日历确认、打开次数、请求次数分别计算中位数和原始 MAD（绝对偏差的中位数），不使用均值，不加缩放系数。
- 缺日不补零；存在的零值参与计算。缺日、重复日期、非法值或没有有效信号历史时输出“信息不足”，不生成数值 D，也不判断“正常”。仅有自动建立的 14 个空白日记录不能完成冷启动。
- 当前版本按用户确认的规则计算：分项 `D=δ/(δ+max(MAD,1))`，`δ=|当前值−中位数|`；总 D 取三个分项最大值。MAD 为零可计算；当前三个指标缺少任一项则 D 为 `null`。此处只计算偏离度，Q、阈值和四格处置属于 #10。
- “有效信号历史”指窗口内至少有一次非零活动，或窗口内发生的打开/服务/成功确认。窗口之前的旧接触时间和窗口结束后的时间均不能补足历史。
- 只处理本社区 active 且 monitor 的老人。`baseline_days` 本版必须为 14，非法配置会显式失败。

`src/engine/l2.js` 提供纯计算。`src/services/baseline.js` 提供事务和查询：

```js
const { runBaseline } = require('./src/jobs/baseline');
const { getCachedBaseline, readBaselineHistory } = require('./src/services/baseline');
const { deviationScore } = require('./src/engine/l2');

await runBaseline();
const record = getCachedBaseline(elderId); // { auditId, snapshot } 或 null
const result = deviationScore(record?.snapshot, {
  calendar_confirmed: 1, app_opens: 2, request_count: 0,
});
const history = await readBaselineHistory(elderId, { limit: 30 });
```

完整快照保存在现有 `audit_log` 中：`action=baseline_calculated`、`target=elder`，含算法版本、窗口、输入行 ID/日期/值和统计结果。重算追加记录，不覆盖旧快照。整批读取/审计写入使用同一事务，提交后才整体发布缓存；失败不发布半批结果。缓存只保留当前进程最近一批并返回副本；进程重启后仍可从审计表查询历史。CLI 退出后内存缓存释放，#12 在服务进程内调用任务体时可持续使用缓存。

`npm test` 运行 L1 日期、L2/L3/L4、调度器、业务时钟和启动配置单测；`npm run test:integration` 运行 L1–L4 以及托管调度的真实 MySQL/HTTP/子进程测试。测试文件串行执行以减少内存占用，用例内部的并发/CAS验证仍保留；各文件使用自己的唯一测试库前缀。

本轮 D 公式是用户于 2026-11-05 确认的项目规则；本地构造数据测试只证明计算和数据路径，不代表异常识别效果或真实用户验证。

### L3 四格分层与 T4（#10）

在 `server/` 执行 `npm run job:stratification`，或在服务进程中调用 `runStratification()`。服务中的 T4 默认每小时自动调用，完成后消费 L4 派单/补证据意图。

- 对最近一个已结束统计日评分；从 `signal_daily` 读取该日和此前 14 天，复用 #9 算法即时计算该窗口基线，不把目标日混入训练，也不使用可能包含目标日的最新缓存。对应目标日的 L1 聚合应先完成；T4 只读输入，不代替 T1 修补数据。
- D 沿用 #9 的公式。Q 参考时点固定为目标日结束时刻：每类来源只取此前最新一条，按 24 小时线性衰减、贡献相加封顶 1。目标日结束及未来事件不参与，过期事件贡献为 0。

| 来源 | 权重 |
|---|---|
| 日历确认 | 0.6 |
| 应用打开 | 0.1 |
| 四键请求 | 0.2 |
| 服务完成 | 0.7 |
| 关系人成功回执 | 0.6 |

D、Q 按数据库精度取三位小数后，分别以 `>=0.5` 为高。输出和处置意图：

| cell | 意图 | 落库 |
|---|---|---|
| strong | dispatch_verify：交给 L4 派核验单 | alert + audit_log |
| insufficient | request_evidence：交给 L4 请求补证据 | alert + audit_log |
| normal | no_intervention：不干预 | audit_log |
| missing | wait_next_scan：不惩罚，等下一轮 | audit_log |

基线未就绪、目标行缺失或指标非法时，状态为“信息不足”，`cell=null`、`D=null`，仅审计，不把未知写成 0。normal/missing 不创建预警，避免污染预警计数。

`alert.d_score` 与 `q_score` 分列存储。`signal_snapshot` 保持数组，包含五类来源、原始 `value`、来源表/ID、时间、权重、新鲜度、贡献及人话说明；日历/打开/请求的当日聚合值另存为 `aggregateValue`，不覆盖按钮类型、录音有无和时长等原始信息。首项的 `context` 保存完整基线、14 天原始输入、当前行、策略版本、分项 D、目标日、处置意图和指纹。H2、R1/R2 按核验单自身的 `alert_id` 读取依据，后来的预警不会替换旧单证据。

同一批内读取和写入使用事务；所有 T4 扫描先锁定同一组 eligible elder 主键，再按决策输入指纹查重。重复或并发扫描不会重复写相同结果。指纹依据指标、基线有效性、规则和规范化来源；行 ID、补采携带的辅助时间仍留在完整快照，但不把同一业务事实的投影补写当作新决策。新指标或新证据可追加新结果，不覆盖旧快照。审计失败时预警一起回滚。

```js
const { runStratification } = require('./src/jobs/stratification');
const result = await runStratification();
// result.results: elderId/status/cell/dScore/qScore/routeIntent/alertId/auditId/duplicate
```

CLI 只打印处理日期和数量，失败输出 `[T4] 分层失败` 并非零退出。`job:stratification` 单独调试分层；托管 T4 才继续消费 L4，T2 独立处理 SLA。本地已验证这条后台调用链，真实触达、真机及界面联调仍需单独验证。

### L4 路由、SLA 与 CAS（#11）

在 `server/` 手动执行：

```bash
npm run job:routing  # 消费尚未派发的 strong/insufficient
npm run job:sla      # T2：处理当前已到期的 SLA
```

服务进程可调用 `runRouting(at?)` 和 `runSlaScan(at?)`。托管调度在 T4 后调用前者、独立每30业务秒调用后者。调用时省略时间即使用统一 `now()`；测试同时包含固定时间驱动的边界验证，以及原生定时器下60倍速触发真实数据库 CAS 升级。

- 普通单按配置的 1–4 层处理，层中唯一启用主责负责计时，同层知会同步收到站内记录。缺少有效主责跳过留痕；承办人/管理员兜底可追加，不实现夜间值班表。关系模式之外显式失败，不伪装为距离路由。
- 首层默认 15 分钟，其他层默认 120 分钟，使用社区参数。普通同一 alert 唯一键幂等；30 秒窗口内同老人普通单合并，保留原 alert_id、通知和截止，补充依据另写事件。
- CAS 同时检查观察到的层、状态、原截止时间及到期条件；CAS 成功才通知下一层和写升级事件。同一事务回滚工单变更、通知和事件，防止半次升级。
- 只锁核验单后再读取回执/结论，避免锁等待期间的旧快照误判重试；回执不反向锁老人主记录，避免与消费者的父/子锁形成环。
- 主责成功停 SLA、工单等待承办确认；主责联系不上立即升级。知会/迟到/重复回执不改路由。派发层按通知快照绑定；未激活的下一层使用新配置。人工转单不延长 SLA，也不会被缺省分配自动换回。
- 配置层缩短不等于跳过承办：系统记住已激活的阶段，必要时把尚未经过的承办兜底追加为新的推进层，保证工单层号单调而不返回旧关系层。
- H3/H4/H5 限当前启用承办人；普通 H1/H2 按派单范围可见，紧急单可广播只读。最终结论要求先有人类动作，耗时和无效核查服务端计算，一单一结论。
- 管理员兜底是可见待办，不自动关单；保留仍启用的承办人处置权限。没有启用承办/管理员也不会伪称已通知或已办结。旧演示单没有路由快照时只提示核对，不猜测旧层并自动迁移。

紧急 E6 不合并不同请求，同 UUID 重试返回同一单。全链关系通知、承办/管理员提示及电话/出发并行指令同事务记录，系统不生成虚假的 call/visit 人类动作。初始 SLA 5 分钟；电话动作不取消上门要求。电话确认未上门只写阶段反馈及自然日午夜截止，不占最终 disposition；重试不延期，既有管理员升级不撤销。出发/上门后进入承办跟进，不能把午夜义务延到次日；最终紧急结论只能以上门方式提交。

首次进入出发跟进时保存固定截止，重复点击、网络重试及后来的 SLA 配置变化不重置该截止。E6 的 promise 仅说明实际生成的站内记录/工作台待办；没有接收人时明确提示无可用人员，并建议联系社区或身边的人协助，不返回“已通知所有联系人”。UUID 重试使用原广播快照，不以后来人员配置假称当时已发送。

先出发再电话确认也不能延长首次跟进截止：订单SLA保留固定截止与午夜中较早者，午夜上门义务单独留档。T4分层完成后，L4以当时业务时间派发并开始计时，避免慢分层提前耗尽SLA。

已成功的 E6 重放在身份、老人归属校验后读取原单，不依赖当前路由配置是否合法；新的请求仍完整校验配置。重放不能跨老人、跨用途，也不能绕过账号停用。

不足证据走独立 R1 提示和 R10 回执，不建核验单。成功形成 family_confirmed，联系不上形成 family_unreachable 及管理员待办，不自动抬高 Q 或造单。新观察可用新 UUID 追加；同 UUID 幂等，原始证据不覆盖。后来的成功仅解决更早的联系不上待办，不能隐藏更新的反馈。

本轮授权的 **R10、R1.evidenceRequests、H2.routing、M1.routingTodos 仍为本地契约草案，待 PM/A/B 评审**；已同步 `docs/04-接口列表.md`，没有远程发布或对外协调。A/B 界面尚未验证是否展示这些可选字段，后端 JSON 可见不等于页面集成完成。

所有检查使用本机隔离库中的构造数据。真实短信、外呼、真实上门、真机和上线行为均未据此验证。

### T1–T4 自动调度与健康（#12）

`npm start` / `npm run dev` 默认启用托管调度。app 模块仅装配路由，导入不会自行启动服务或任务。UTC+8 下，T1 读取 `param.day_cut_hour`（默认04:00），T2 默认每30秒，T3 默认03:00，T4 默认每60分钟；其他频率见 `.env.example` 的 `JOB_*` 启动配置。

- 启动立即尝试 T2；日批按 T1→T3→T4 补跑最新周期一次，T4 后消费 L4，不追放全部历史 tick。T1 未完成/失败时不放行相关 T4；T3 失败不阻止会独立复算基线的 T4。坏日批切点不阻止独立 T2 启动。
- 同一任务覆盖执行及健康完成记录的互斥。慢日批不在调度层阻塞 T2；原任务体依靠事务、幂等和 CAS 防止重复结果。失败只记录安全错误码，不打印原始异常消息、SQL、凭据或个人输入；按真实30秒退避重试。
- `audit_log` 保存 `job_started / job_succeeded / job_failed` 和完整健康快照。数据库留档失败仍保留内存错误/安全日志，不能显示健康。重启恢复历史时间/计数后，重新补跑当前周期；旧 running 记录不代表新进程正在运行。
- 独立 MySQL 会话持有调度所有权，不占用业务连接池。另一实例处于 standby，不重复执行任务；失锁立即停止新派发，初始化期间失锁也不能启动。长初始化收尾后仍保留恢复重试。
- M1 的可选 `jobs` 提供各任务健康、执行/成功/失败时间及计数；`lastJobAt` 取本实例观察到的 T2 最近成功时间。执行健康用真实时间，超过两分钟没有成功不能显示绿色；停止、备用、禁用、失败或持久化异常也不能假装健康。公共 `/api/health` 仍只检验数据库连通。
- 停机先取消定时器并等待在途任务和 HTTP 请求完成，再释放所有权和连接池。硬杀时数据库会释放会话锁，未完成记录不能当作成功；不提供跨任意手动脚本、网络分区或强制终止的全局恰好一次保证。

开发 D3 与 M8 共用一个业务时钟：1/10/60 切换保持业务时间连续、基准保存至现有审计表、重启可恢复。T1–T4、#11核验路由/回执及 SLA 倒计时使用同一 `now()`；退避/健康/HTTP耗时保持真实时间。业务请求先等待时钟恢复，备用/停用实例每次请求前刷新；同步失败不会放行错误时间。生产拒绝非1倍，M8不能绕过。服务单支付/接单和 D2 旧演示数据没有在本轮作全站时间重构。

D1 只允许开发环境的启用管理员，在 `JOBS_ENABLED=false` 并重启、且其他实例均未持有所有权时重置当前配置的数据库。运行/备用中的自动调度会返回409；维护锁阻止重置期间另一托管实例启动。完成后复位倍率及本实例健康；其他进程之后同步也能识别审计序号已被重置。M1健康扩展及 D1/D3/M8 联动已同步 `docs/04` 为**本地草案，待 B/PM 评审**，页面尚未验证是否显示。

新增验证包括：配置时间边界/并发/安全失败日志/退避/健康过期、真实 MySQL 任务留档和恢复、启动失锁及恢复竞态、真实 T1/T3/T4→L4、原生定时器跨03:00/04:00、实际 `src/index.js` 默认自启、独立备用进程时钟、HTTP清库保护及倍速SLA自动升级。Windows入口停机测试用仅测试的 IPC 触发实际注册的 SIGTERM 处理器；不把它当作操作系统强杀、Unix信号或线上恢复验证。

完整验收结果与未验证范围见 `docs/superpowers/plans/2026-11-05-job-scheduler.md`。内存较少时可为测试进程设置 `NODE_OPTIONS=--max-old-space-size=96`；不会改变实际服务配置或关闭其他应用。

本轮整体提交前复核及最新测试结果见 `docs/superpowers/plans/2026-11-05-c-engine-pr-review.md`。初始化与M8读写/发布计划共享控制锁，新owner会重做同步；停机各初始化分支均等HTTP及任务排空后才释放所有权，D1检查配置已禁用而非仅检查循环已停止。

L3 测试每次使用独立 `yinling_l3_test_...` 数据库，覆盖四格、分列落库、快照、并发查重、T1 投影前后查重、失败回滚，以及真实 H2/R1/R2 的证据绑定。权重和阈值是用户于 2026-11-05 确认的项目规则；本地构造数据验证不代表真实异常识别效果。

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

- PM/A/B 评审 #11/#12 契约草案，接入提示/待办和任务健康界面并联调
