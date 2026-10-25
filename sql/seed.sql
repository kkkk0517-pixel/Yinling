-- ============================================================
-- 银铃 · 种子数据（演示用）
-- 用法：mysql -u root -p yinling < sql/seed.sql
-- 登录：手机号 + 验证码 123456
-- ============================================================

USE yinling;

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE person; TRUNCATE TABLE elder; TRUNCATE TABLE relation_group;
TRUNCATE TABLE relation; TRUNCATE TABLE invite_code;
TRUNCATE TABLE signal_daily; TRUNCATE TABLE signal_event; TRUNCATE TABLE alert;
TRUNCATE TABLE verify_order; TRUNCATE TABLE service_order; TRUNCATE TABLE order_event;
TRUNCATE TABLE disposition; TRUNCATE TABLE notification;
TRUNCATE TABLE wallet; TRUNCATE TABLE wallet_txn; TRUNCATE TABLE bill;
TRUNCATE TABLE param; TRUNCATE TABLE true_event; TRUNCATE TABLE audit_log;
SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- 人员
-- ------------------------------------------------------------
INSERT INTO person (id, phone, name, functions, role_label) VALUES
(1, '13800000001', '张桂芳', '["resident"]',                    NULL),
(2, '13800000002', '李敏',   '["relation","service"]',           NULL),
(3, '13800000003', '李强',   '["relation","service"]',           NULL),
(4, '13800000004', '王姨',   '["relation","service"]',           NULL),
(5, '13800000005', '陈师傅', '["agent"]',                        '社区工作者'),
(6, '13800000006', '小张',   '["admin"]',                        NULL),
(7, '13800000007', '王建国', '["resident"]',                     NULL),
(8, '13800000008', '王强',   '["relation","service"]',           NULL),
(9, '13800000009', '刘秀英', '["resident"]',                     NULL);

-- ------------------------------------------------------------
-- 老人档案：一位全量监测、一位有责任组、一位仅建档
-- ------------------------------------------------------------
INSERT INTO elder (id, person_id, name, birth_year, addr, mode, monitor_level) VALUES
(1, 1, '张桂芳', 1948, '3 栋 201', 'self',  'monitor'),
(2, 7, '王建国', 1944, '5 栋 102', 'self',  'monitor'),
(3, 9, '刘秀英', 1951, '7 栋 303', 'self',  'record_only');

-- ------------------------------------------------------------
-- 关系组与关系链
-- ------------------------------------------------------------
INSERT INTO relation_group (id, elder_id, level, form, name) VALUES
(1, 1, 1, 'group',  '李家子女组'),
(2, 2, 1, 'single', '王强');

INSERT INTO relation (elder_id, person_id, group_id, level, role_label, is_accountable, priority) VALUES
(1, 2, 1, 1, '家属',       1, 1),
(1, 3, 1, 1, '家属',       0, 2),
(1, 4, 1, 1, '结对志愿者', 0, 3),
(2, 8, 2, 1, '家属',       1, 1);

-- ------------------------------------------------------------
-- 近 5 天信号：张桂芳 10-24 起中断，用来演示预警
-- ------------------------------------------------------------
INSERT INTO signal_daily (elder_id, stat_date, calendar_confirmed, app_opens, request_count, last_open_at, last_service_at, last_confirm_at) VALUES
(1, CURDATE() - INTERVAL 4 DAY, 1, 3, 0, CURDATE() - INTERVAL 4 DAY + INTERVAL 9 HOUR, CURDATE() - INTERVAL 6 DAY, CURDATE() - INTERVAL 4 DAY + INTERVAL 9 HOUR),
(1, CURDATE() - INTERVAL 3 DAY, 1, 2, 0, CURDATE() - INTERVAL 3 DAY + INTERVAL 10 HOUR, CURDATE() - INTERVAL 6 DAY, CURDATE() - INTERVAL 3 DAY + INTERVAL 10 HOUR),
(1, CURDATE() - INTERVAL 2 DAY, 1, 4, 1, CURDATE() - INTERVAL 2 DAY + INTERVAL 8 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 15 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 8 HOUR),
(1, CURDATE() - INTERVAL 1 DAY, 0, 0, 0, CURDATE() - INTERVAL 2 DAY + INTERVAL 20 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 15 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 8 HOUR),
(1, CURDATE(),                  0, 0, 0, CURDATE() - INTERVAL 2 DAY + INTERVAL 20 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 15 HOUR, CURDATE() - INTERVAL 2 DAY + INTERVAL 8 HOUR),
(2, CURDATE(),                  1, 1, 0, CURDATE() + INTERVAL 7 HOUR,  CURDATE() - INTERVAL 9 DAY, CURDATE() + INTERVAL 7 HOUR);

-- ------------------------------------------------------------
-- 一条待处理预警 + 核验单（演示时工作台不是空的）
-- ------------------------------------------------------------
INSERT INTO alert (id, elder_id, d_score, q_score, cell, signal_snapshot) VALUES
(1, 1, 0.720, 0.610, 'strong',
 JSON_ARRAY(
   JSON_OBJECT('signal','calendar_confirmed','value',0,'days',2,'weight',0.4,'note','连续 2 天未撕日历'),
   JSON_OBJECT('signal','app_open','value',0,'days',1,'weight',0.2,'note','全天未打开'),
   JSON_OBJECT('signal','last_service','value',DATE_FORMAT(CURDATE() - INTERVAL 3 DAY,'%Y-%m-%d'),'weight',0.3,'note','最近一次志愿者上门')
 ));

INSERT INTO verify_order (id, elder_id, alert_id, source, current_layer, status, route_mode, sla_deadline) VALUES
(1, 1, 1, 'alert', 1, 'notified', 'relation', NOW() + INTERVAL 12 MINUTE);

INSERT INTO notification (order_type, order_id, relation_id, person_id, is_accountable, sent_at) VALUES
('verify', 1, 1, 2, 1, NOW()),
('verify', 1, 2, 3, 0, NOW()),
('verify', 1, 3, 4, 0, NOW());

INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES
('verify', 1, NULL, 'notify', JSON_OBJECT('layer', 1, 'count', 3));

-- ------------------------------------------------------------
-- 一张已完成的服务单 + 待付账单（演示账单页）
-- ------------------------------------------------------------
INSERT INTO service_order (id, elder_id, key_type, audio_file_id, audio_duration, content_text,
                           status, assignee_id, assignee_role, addr, amount, client_request_id,
                           created_at, accepted_at, done_at) VALUES
(1, 1, 'buy', NULL, 12, '想买米和酱油', 'done', 2, 'family', '3 栋 201', 38.00,
 'seed-service-0001', NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 1 DAY);

INSERT INTO bill (service_order_id, elder_id, payer_person_id, amount, status) VALUES
(1, 1, 2, 38.00, 'pending');

INSERT INTO wallet (person_id, balance) VALUES (2, 200.00);
INSERT INTO wallet_txn (wallet_id, type, amount, balance_after, note) VALUES
(1, 'recharge', 200.00, 200.00, '演示初始余额');

-- ------------------------------------------------------------
-- 社区参数
-- ------------------------------------------------------------
INSERT INTO param (community_id, k, v) VALUES
(1, 'layer_count',          '3'),
(1, 'layer1_wait_min',      '15'),
(1, 'layer2_wait_min',      '120'),
(1, 'route_mode',           'relation'),
(1, 'merge_window_sec',     '30'),
(1, 'day_cut_hour',         '4'),
(1, 'baseline_days',        '14'),
(1, 'time_scale',           '1'),
(1, 'service_pool_wait_min','10'),
(1, 'bill_limit',           '500'),
(1, 'role_label_agent',     '社区工作者');
