# 银铃 · 数据表 DDL v0.1

> 对应：`docs/03-系统端页面表.md`、`docs/02-系统端功能规格.md` v0.5
> 数据库：MySQL 8.0 / utf8mb4
> 日期：2026-10-23

---

## 零、三条设计约定

**① 时间一律存绝对时刻，不存"剩余秒数"。**
SLA 只存 `sla_deadline`（绝对时间），服务重启后按 `NOW()` 重算，天然可恢复。存"剩余 900 秒"重启就全乱。

**② 幂等靠唯一键，不靠代码判断。**
老人端每次提交带 `client_request_id`（UUID v4），表上建唯一索引。重复请求直接撞唯一键，返回已有单据。

**③ 核验单与服务单**分表**，不共用状态枚举。**
两条链的结论、字段、状态都不同。管理端要一起看时用视图 `v_order_all`。

---

## 一、人员与关系

```sql
-- 所有人（老人、家属、志愿者、承办人、管理员）都在这张表
CREATE TABLE person (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  phone         VARCHAR(20)  NOT NULL UNIQUE COMMENT '登录账号',
  name          VARCHAR(50)  NOT NULL,
  community_id  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  functions     JSON         NOT NULL COMMENT '职能身份数组：resident/relation/service/agent/admin',
  role_label    VARCHAR(30)  NULL COMMENT '显示名，如"楼栋长"，可配',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0停用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_community (community_id, status)
) COMMENT='用户/人员';

-- 老人档案
CREATE TABLE elder (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  person_id     BIGINT UNSIGNED NOT NULL COMMENT '老人本人的 person 记录',
  name          VARCHAR(50)  NOT NULL,
  birth_year    SMALLINT     NOT NULL,
  addr          VARCHAR(200) NOT NULL,
  addr_lat      DECIMAL(9,6) NULL,
  addr_lng      DECIMAL(9,6) NULL,
  mode          ENUM('self','proxy') NOT NULL DEFAULT 'self' COMMENT 'proxy=家属代管',
  monitor_level ENUM('monitor','record_only') NOT NULL DEFAULT 'monitor'
                COMMENT 'monitor=参与预警；record_only=仅建档',
  status        ENUM('active','paused','removed') NOT NULL DEFAULT 'active',
  community_id  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_person (person_id),
  KEY idx_status (community_id, status, monitor_level)
) COMMENT='老人档案';

-- 关系组：第 1 层可以是组（兄弟姐妹）、单点、或结对志愿者
CREATE TABLE relation_group (
  id        BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id  BIGINT UNSIGNED NOT NULL,
  level     TINYINT NOT NULL COMMENT '第几层，从 1 开始',
  form      ENUM('group','single','volunteer') NOT NULL DEFAULT 'group',
  name      VARCHAR(50) NULL COMMENT '如"李家子女组"',
  KEY idx_elder (elder_id, level),
  CONSTRAINT fk_rg_elder FOREIGN KEY (elder_id) REFERENCES elder(id)
) COMMENT='关系组';

-- 关系人：谁跟这位老人有关系、在第几层、是不是主责
CREATE TABLE relation (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id       BIGINT UNSIGNED NOT NULL,
  person_id      BIGINT UNSIGNED NOT NULL,
  group_id       BIGINT UNSIGNED NULL,
  level          TINYINT NOT NULL,
  role_label     VARCHAR(20) NOT NULL COMMENT '家属/结对志愿者/邻居·楼栋长',
  is_accountable TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=主责，必须回执',
  priority       INT NOT NULL DEFAULT 0 COMMENT '同层排序',
  status         TINYINT NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_elder_person (elder_id, person_id),
  KEY idx_elder_level (elder_id, level, priority),
  CONSTRAINT fk_rel_elder FOREIGN KEY (elder_id) REFERENCES elder(id),
  CONSTRAINT fk_rel_person FOREIGN KEY (person_id) REFERENCES person(id)
) COMMENT='关系链';

-- 邀请码：家属生成，老人输入
CREATE TABLE invite_code (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code        CHAR(6) NOT NULL UNIQUE,
  elder_id    BIGINT UNSIGNED NOT NULL,
  created_by  BIGINT UNSIGNED NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  used_by     BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_elder (elder_id)
) COMMENT='绑定邀请码';
```

---

## 二、信号与预警

```sql
-- 每日聚合信号：L1 的主要输入
CREATE TABLE signal_daily (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NOT NULL,
  stat_date         DATE NOT NULL COMMENT '按 04:00 切日归属',
  calendar_confirmed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=当天撕了日历（强确认）',
  app_opens         INT NOT NULL DEFAULT 0,
  request_count     INT NOT NULL DEFAULT 0,
  last_open_at      DATETIME NULL,
  last_service_at   DATETIME NULL COMMENT '最近一次社区服务/上门',
  last_confirm_at   DATETIME NULL COMMENT '最近一次家属确认',
  UNIQUE KEY uk_elder_date (elder_id, stat_date),
  KEY idx_date (stat_date)
) COMMENT='每日信号聚合';

-- 埋点明细：可溯源用，v1 只写不查
CREATE TABLE signal_event (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NULL,
  type              VARCHAR(32) NOT NULL COMMENT 'app_open/calendar_confirmed/button_pressed/...',
  payload           JSON NULL,
  client_request_id VARCHAR(64) NULL,
  ts                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_client (client_request_id),
  KEY idx_elder_ts (elder_id, ts)
) COMMENT='埋点明细';

-- 预警：L3 的输出，一单一条
CREATE TABLE alert (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id         BIGINT UNSIGNED NOT NULL,
  d_score          DECIMAL(4,3) NOT NULL COMMENT '偏离度 D 0.000-1.000',
  q_score          DECIMAL(4,3) NOT NULL COMMENT '置信度 Q 0.000-1.000',
  cell             ENUM('strong','insufficient','normal','missing') NOT NULL
                   COMMENT 'D高Q高=strong；D高Q低=insufficient；其余两格',
  signal_snapshot  JSON NOT NULL COMMENT '当时用了哪些信号、值、权重、新鲜度',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_elder_time (elder_id, created_at)
) COMMENT='预警（可溯源）';
```

> `signal_snapshot` 必须存完整快照。核验单卡片上"依据 3 条信号"就是从这读的。不存快照，卡片上的原因就是编的。

---

## 三、工单

```sql
-- 核验单：系统触发，指派制
CREATE TABLE verify_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NOT NULL,
  alert_id          BIGINT UNSIGNED NULL COMMENT '紧急单可为空',
  source            ENUM('alert','emergency','manual') NOT NULL,
  current_layer     TINYINT NOT NULL DEFAULT 1 COMMENT '当前在第几层，升级就 +1',
  status            ENUM('pending','notified','escalated','assigned','closed','cancelled') NOT NULL DEFAULT 'pending',
  route_mode        ENUM('relation','distance') NOT NULL DEFAULT 'relation',
  assignee_id       BIGINT UNSIGNED NULL COMMENT '落到哪个承办人',
  sla_deadline      DATETIME NULL COMMENT '当前层截止的绝对时刻',
  client_request_id VARCHAR(64) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at         DATETIME NULL,
  UNIQUE KEY uk_client (client_request_id),
  KEY idx_scan (status, sla_deadline) COMMENT '定时任务扫描用',
  KEY idx_assignee (assignee_id, status),
  KEY idx_elder (elder_id, created_at)
) COMMENT='核验单';

-- 服务单：老人触发，先派关系人再落池
CREATE TABLE service_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NOT NULL,
  key_type          ENUM('buy','unwell','repair','medical') NOT NULL COMMENT '对应老人端四键',
  sub_type          ENUM('accompany_visit','accompany_pickup') NULL COMMENT 'medical 细分',
  audio_file_id     VARCHAR(200) NULL COMMENT '录音地址，永久留存',
  audio_duration    INT NULL COMMENT '秒',
  content_text      VARCHAR(500) NULL COMMENT '老人描述（若已转写）',
  status            ENUM('pending','assigned','accepted','doing','done','closed','cancelled') NOT NULL DEFAULT 'pending',
  assignee_id       BIGINT UNSIGNED NULL,
  assignee_role     ENUM('family','volunteer','agent','vendor') NULL,
  addr              VARCHAR(200) NULL,
  amount            DECIMAL(10,2) NULL COMMENT '完成时填，用于生成账单',
  client_request_id VARCHAR(64) NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at       DATETIME NULL,
  done_at           DATETIME NULL,
  UNIQUE KEY uk_client (client_request_id),
  KEY idx_status (status, created_at),
  KEY idx_elder (elder_id, created_at)
) COMMENT='服务单';

-- 工单事件流：所有状态变化都写一条，用于算响应时长和升级次数
CREATE TABLE order_event (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_type ENUM('verify','service') NOT NULL,
  order_id   BIGINT UNSIGNED NOT NULL,
  actor_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(32) NOT NULL COMMENT 'notify/read/ack/escalate/call/visit/dispose/close/transfer',
  payload    JSON NULL,
  ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order (order_type, order_id, ts)
) COMMENT='工单事件流';

-- 处置结论：一张核验单只有一条
CREATE TABLE disposition (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id         BIGINT UNSIGNED NOT NULL,
  result_code      ENUM('normal','abnormal_handled','unreachable_escalated','declined','phone_confirmed_not_visited') NOT NULL,
  method           ENUM('phone','visit') NOT NULL,
  duration_min     INT NULL COMMENT '自动算：首次动作到结论',
  note             VARCHAR(100) NULL,
  is_invalid_check TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'normal/declined 记 1',
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order (order_id) COMMENT '一单一结论',
  KEY idx_time (created_at)
) COMMENT='处置结论（台账数据源）';

-- 管理端工单列表用
CREATE OR REPLACE VIEW v_order_all AS
SELECT 'verify' AS order_type, id, elder_id, status, assignee_id, created_at, closed_at FROM verify_order
UNION ALL
SELECT 'service', id, elder_id, status, assignee_id, created_at, done_at FROM service_order;
```

> `disposition.is_invalid_check` 是主指标"无效核查次数"的唯一来源。**只在服务端算，不接受前端传。**

---

## 四、通知与回执

```sql
CREATE TABLE notification (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_type     ENUM('verify','service') NOT NULL,
  order_id       BIGINT UNSIGNED NOT NULL,
  relation_id    BIGINT UNSIGNED NOT NULL,
  person_id      BIGINT UNSIGNED NOT NULL,
  is_accountable TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=主责，回执才停计时',
  channel        ENUM('inapp') NOT NULL DEFAULT 'inapp' COMMENT 'v1 只做站内',
  sent_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at        DATETIME NULL,
  ack_at         DATETIME NULL,
  ack_result     ENUM('ok_visited','ok_called','unreachable') NULL,
  KEY idx_person_unread (person_id, ack_at),
  KEY idx_order (order_type, order_id)
) COMMENT='通知与回执';
```

---

## 五、账单与钱包

```sql
CREATE TABLE wallet (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  person_id  BIGINT UNSIGNED NOT NULL,
  balance    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_person (person_id)
) COMMENT='家属余额（记账，非真实支付）';

CREATE TABLE wallet_txn (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wallet_id     BIGINT UNSIGNED NOT NULL,
  type          ENUM('recharge','pay','refund') NOT NULL,
  amount        DECIMAL(10,2) NOT NULL COMMENT '正数入账，负数出账',
  balance_after DECIMAL(10,2) NOT NULL,
  ref_type      VARCHAR(20) NULL COMMENT 'bill',
  ref_id        BIGINT UNSIGNED NULL,
  note          VARCHAR(100) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wallet (wallet_id, created_at)
) COMMENT='余额流水';

CREATE TABLE bill (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  service_order_id BIGINT UNSIGNED NOT NULL,
  elder_id        BIGINT UNSIGNED NOT NULL,
  payer_person_id BIGINT UNSIGNED NULL COMMENT '默认主责，可改',
  amount          DECIMAL(10,2) NOT NULL,
  status          ENUM('pending','paid','waived') NOT NULL DEFAULT 'pending',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         DATETIME NULL,
  UNIQUE KEY uk_order (service_order_id),
  KEY idx_payer (payer_person_id, status)
) COMMENT='服务单账单';
```

> 支付是"确认扣减"，没有第三方回调。扣款必须在事务里：查余额 → 扣 wallet → 写 txn → 改 bill 状态。

---

## 六、配置与留档

```sql
CREATE TABLE param (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
  k            VARCHAR(64) NOT NULL,
  v            VARCHAR(255) NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ck (community_id, k)
) COMMENT='社区参数';

-- 初始参数
INSERT INTO param (community_id, k, v) VALUES
(1,'layer_count','3'),
(1,'layer1_wait_min','15'),
(1,'layer2_wait_min','120'),
(1,'route_mode','relation'),
(1,'merge_window_sec','30'),
(1,'day_cut_hour','4'),
(1,'baseline_days','14'),
(1,'time_scale','1'),
(1,'service_pool_wait_min','10'),
(1,'bill_limit','500'),
(1,'role_label_agent','社区工作者');

-- 真异常（召回率分母）：v1 只建表不录页
CREATE TABLE true_event (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id     BIGINT UNSIGNED NOT NULL,
  occurred_at  DATETIME NOT NULL,
  found_by     ENUM('family','neighbor','community','mechanism') NOT NULL,
  confirmed_at DATETIME NULL,
  note         VARCHAR(200) NULL
) COMMENT='真异常事件（人工回溯）';

-- 审计：v1 不做页面，表留着
CREATE TABLE audit_log (
  id        BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  actor_id  BIGINT UNSIGNED NULL,
  action    VARCHAR(50) NOT NULL,
  target    VARCHAR(50) NOT NULL,
  target_id BIGINT UNSIGNED NULL,
  payload   JSON NULL,
  ts        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ts (ts)
) COMMENT='操作日志';
```

---

## 七、四个关键约束（写代码时最容易漏）

### 7.1 SLA 升级必须用 CAS，不能先查后改

```sql
-- 对
UPDATE verify_order
   SET current_layer = current_layer + 1,
       sla_deadline  = DATE_ADD(NOW(), INTERVAL ? MINUTE),
       status        = 'escalated'
 WHERE id = ? AND current_layer = ? AND status IN ('notified','escalated');
-- 影响行数 = 0 说明别人已经升级过了，跳过
```

先 `SELECT` 再 `UPDATE`，两个定时任务同时跑会把单子升两级。

### 7.2 一单只能有一条结论

`disposition.order_id` 上有唯一索引。重复提交撞键 → 返回已有结论，不报错。

### 7.3 主责回执才停计时

```sql
UPDATE verify_order o
  JOIN notification n ON n.order_id = o.id AND n.order_type = 'verify'
   SET o.sla_deadline = NULL
 WHERE n.id = ? AND n.is_accountable = 1 AND o.status IN ('notified','escalated');
```

知会点了只写 `ack_at`，不动 `sla_deadline`。

### 7.4 30 秒内同类服务单合并

```sql
SELECT * FROM service_order
 WHERE elder_id = ? AND key_type = ?
   AND created_at > DATE_SUB(NOW(), INTERVAL 30 SECOND)
   AND status IN ('pending','assigned','accepted','doing')
 LIMIT 1;
```

查到就返回已有单。**紧急单不做合并。**

---

## 八、索引清单（按查询场景）

| 场景 | 用的索引 |
|---|---|
| 定时任务扫超时单 | `verify_order(status, sla_deadline)` |
| 承办人看"我名下" | `verify_order(assignee_id, status)` |
| 关系人看未读通知 | `notification(person_id, ack_at)` |
| 算 D 值取近 14 天 | `signal_daily(elder_id, stat_date)` 唯一键直接命中 |
| 管理端工单列表 | 视图 `v_order_all` + 各自 `created_at` |
| 算无效核查次数 | `disposition(created_at)` |
