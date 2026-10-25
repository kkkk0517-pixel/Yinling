-- ============================================================
-- 银铃 · 建库脚本
-- MySQL 8.0 / utf8mb4
-- 用法：mysql -u root -p < sql/schema.sql
-- ============================================================

DROP DATABASE IF EXISTS yinling;
CREATE DATABASE yinling DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE yinling;

-- ------------------------------------------------------------
-- 一、人员与关系
-- ------------------------------------------------------------

CREATE TABLE person (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  phone         VARCHAR(20)  NOT NULL UNIQUE COMMENT '登录账号',
  name          VARCHAR(50)  NOT NULL,
  community_id  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  functions     JSON         NOT NULL COMMENT '职能身份：resident/relation/service/agent/admin',
  role_label    VARCHAR(30)  NULL COMMENT '显示名，如"楼栋长"',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1正常 0停用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_community (community_id, status)
) ENGINE=InnoDB COMMENT='用户/人员';

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
  KEY idx_status (community_id, status, monitor_level),
  CONSTRAINT fk_elder_person FOREIGN KEY (person_id) REFERENCES person(id)
) ENGINE=InnoDB COMMENT='老人档案';

CREATE TABLE relation_group (
  id        BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id  BIGINT UNSIGNED NOT NULL,
  level     TINYINT NOT NULL COMMENT '第几层，从 1 开始',
  form      ENUM('group','single','volunteer') NOT NULL DEFAULT 'group',
  name      VARCHAR(50) NULL COMMENT '如"李家子女组"',
  KEY idx_elder (elder_id, level),
  CONSTRAINT fk_rg_elder FOREIGN KEY (elder_id) REFERENCES elder(id)
) ENGINE=InnoDB COMMENT='关系组';

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
  CONSTRAINT fk_rel_elder  FOREIGN KEY (elder_id)  REFERENCES elder(id),
  CONSTRAINT fk_rel_person FOREIGN KEY (person_id) REFERENCES person(id)
) ENGINE=InnoDB COMMENT='关系链';

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
) ENGINE=InnoDB COMMENT='绑定邀请码';

-- ------------------------------------------------------------
-- 二、信号与预警
-- ------------------------------------------------------------

CREATE TABLE signal_daily (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id           BIGINT UNSIGNED NOT NULL,
  stat_date          DATE NOT NULL COMMENT '按 04:00 切日归属',
  calendar_confirmed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=当天撕了日历',
  app_opens          INT NOT NULL DEFAULT 0,
  request_count      INT NOT NULL DEFAULT 0,
  last_open_at       DATETIME NULL,
  last_service_at    DATETIME NULL COMMENT '最近一次社区服务/上门',
  last_confirm_at    DATETIME NULL COMMENT '最近一次家属确认',
  UNIQUE KEY uk_elder_date (elder_id, stat_date),
  KEY idx_date (stat_date)
) ENGINE=InnoDB COMMENT='每日信号聚合';

CREATE TABLE signal_event (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NULL,
  type              VARCHAR(32) NOT NULL COMMENT 'app_open/calendar_confirmed/button_pressed/...',
  payload           JSON NULL,
  client_request_id VARCHAR(64) NULL,
  ts                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_client (client_request_id),
  KEY idx_elder_ts (elder_id, ts)
) ENGINE=InnoDB COMMENT='埋点明细';

CREATE TABLE alert (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id        BIGINT UNSIGNED NOT NULL,
  d_score         DECIMAL(4,3) NOT NULL COMMENT '偏离度 D',
  q_score         DECIMAL(4,3) NOT NULL COMMENT '置信度 Q',
  cell            ENUM('strong','insufficient','normal','missing') NOT NULL
                  COMMENT 'D高Q高=strong；D高Q低=insufficient',
  signal_snapshot JSON NOT NULL COMMENT '当时用了哪些信号、值、权重、新鲜度',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_elder_time (elder_id, created_at)
) ENGINE=InnoDB COMMENT='预警（可溯源）';

-- ------------------------------------------------------------
-- 三、工单
-- ------------------------------------------------------------

CREATE TABLE verify_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NOT NULL,
  alert_id          BIGINT UNSIGNED NULL COMMENT '紧急单可为空',
  source            ENUM('alert','emergency','manual') NOT NULL,
  current_layer     TINYINT NOT NULL DEFAULT 1,
  status            ENUM('pending','notified','escalated','assigned','closed','cancelled')
                    NOT NULL DEFAULT 'pending',
  route_mode        ENUM('relation','distance') NOT NULL DEFAULT 'relation',
  assignee_id       BIGINT UNSIGNED NULL COMMENT '落到哪个承办人',
  sla_deadline      DATETIME NULL COMMENT '当前层截止的绝对时刻',
  client_request_id VARCHAR(64) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at         DATETIME NULL,
  UNIQUE KEY uk_client (client_request_id),
  KEY idx_scan (status, sla_deadline),
  KEY idx_assignee (assignee_id, status),
  KEY idx_elder (elder_id, created_at),
  CONSTRAINT fk_vo_elder FOREIGN KEY (elder_id) REFERENCES elder(id)
) ENGINE=InnoDB COMMENT='核验单';

CREATE TABLE service_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id          BIGINT UNSIGNED NOT NULL,
  key_type          ENUM('buy','unwell','repair','medical') NOT NULL COMMENT '老人端四键',
  sub_type          ENUM('accompany_visit','accompany_pickup') NULL COMMENT 'medical 细分',
  audio_file_id     VARCHAR(200) NULL COMMENT '录音地址，永久留存',
  audio_duration    INT NULL COMMENT '秒',
  content_text      VARCHAR(500) NULL,
  status            ENUM('pending','assigned','accepted','doing','done','closed','cancelled')
                    NOT NULL DEFAULT 'pending',
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
  KEY idx_elder (elder_id, created_at),
  CONSTRAINT fk_so_elder FOREIGN KEY (elder_id) REFERENCES elder(id)
) ENGINE=InnoDB COMMENT='服务单';

CREATE TABLE order_event (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_type ENUM('verify','service') NOT NULL,
  order_id   BIGINT UNSIGNED NOT NULL,
  actor_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(32) NOT NULL COMMENT 'notify/read/ack/escalate/call/visit/dispose/close/transfer',
  payload    JSON NULL,
  ts         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_order (order_type, order_id, ts)
) ENGINE=InnoDB COMMENT='工单事件流';

CREATE TABLE disposition (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id         BIGINT UNSIGNED NOT NULL,
  result_code      ENUM('normal','abnormal_handled','unreachable_escalated','declined','phone_confirmed_not_visited') NOT NULL,
  method           ENUM('phone','visit') NOT NULL,
  duration_min     INT NULL COMMENT '服务端算：首次动作到结论',
  note             VARCHAR(100) NULL,
  is_invalid_check TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'normal/declined 记 1',
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_order (order_id),
  KEY idx_time (created_at)
) ENGINE=InnoDB COMMENT='处置结论（台账数据源）';

CREATE OR REPLACE VIEW v_order_all AS
SELECT 'verify' AS order_type, id, elder_id, status, assignee_id, created_at, closed_at AS finished_at
  FROM verify_order
UNION ALL
SELECT 'service', id, elder_id, status, assignee_id, created_at, done_at
  FROM service_order;

-- ------------------------------------------------------------
-- 四、通知与回执
-- ------------------------------------------------------------

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
) ENGINE=InnoDB COMMENT='通知与回执';

-- ------------------------------------------------------------
-- 五、账单与钱包
-- ------------------------------------------------------------

CREATE TABLE wallet (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  person_id  BIGINT UNSIGNED NOT NULL,
  balance    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_person (person_id)
) ENGINE=InnoDB COMMENT='家属余额（记账，非真实支付）';

CREATE TABLE wallet_txn (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  wallet_id     BIGINT UNSIGNED NOT NULL,
  type          ENUM('recharge','pay','refund') NOT NULL,
  amount        DECIMAL(10,2) NOT NULL COMMENT '正数入账，负数出账',
  balance_after DECIMAL(10,2) NOT NULL,
  ref_type      VARCHAR(20) NULL,
  ref_id        BIGINT UNSIGNED NULL,
  note          VARCHAR(100) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wallet (wallet_id, created_at)
) ENGINE=InnoDB COMMENT='余额流水';

CREATE TABLE bill (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  service_order_id BIGINT UNSIGNED NOT NULL,
  elder_id         BIGINT UNSIGNED NOT NULL,
  payer_person_id  BIGINT UNSIGNED NULL COMMENT '默认主责，可改',
  amount           DECIMAL(10,2) NOT NULL,
  status           ENUM('pending','paid','waived') NOT NULL DEFAULT 'pending',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at          DATETIME NULL,
  UNIQUE KEY uk_order (service_order_id),
  KEY idx_payer (payer_person_id, status)
) ENGINE=InnoDB COMMENT='服务单账单';

-- ------------------------------------------------------------
-- 六、配置与留档
-- ------------------------------------------------------------

CREATE TABLE param (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  community_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
  k            VARCHAR(64) NOT NULL,
  v            VARCHAR(255) NOT NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ck (community_id, k)
) ENGINE=InnoDB COMMENT='社区参数';

CREATE TABLE true_event (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id     BIGINT UNSIGNED NOT NULL,
  occurred_at  DATETIME NOT NULL,
  found_by     ENUM('family','neighbor','community','mechanism') NOT NULL,
  confirmed_at DATETIME NULL,
  note         VARCHAR(200) NULL
) ENGINE=InnoDB COMMENT='真异常事件（召回率分母，人工回溯）';

CREATE TABLE audit_log (
  id        BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  actor_id  BIGINT UNSIGNED NULL,
  action    VARCHAR(50) NOT NULL,
  target    VARCHAR(50) NOT NULL,
  target_id BIGINT UNSIGNED NULL,
  payload   JSON NULL,
  ts        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ts (ts)
) ENGINE=InnoDB COMMENT='操作日志';
