/**
 * 银铃 · Mock 假数据
 * 与 sql/seed.sql 保持一致：3 位老人、6 个关系人、2 个承办人、1 个管理员
 * 所有时间均为字符串 'YYYY-MM-DD HH:mm:ss'
 */

const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const plusMin = (min) => {
  const d = new Date(Date.now() + min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ---------------- 人员 ----------------
const persons = [
  { id: 1, phone: '13800000001', name: '张桂芳', functions: ['resident'], roleLabel: null },
  { id: 2, phone: '13800000002', name: '李敏', functions: ['relation', 'service'], roleLabel: null },
  { id: 3, phone: '13800000003', name: '李强', functions: ['relation', 'service'], roleLabel: null },
  { id: 4, phone: '13800000004', name: '王姨', functions: ['relation', 'service'], roleLabel: '结对志愿者' },
  { id: 5, phone: '13800000005', name: '陈师傅', functions: ['agent'], roleLabel: '社区工作者' },
  { id: 6, phone: '13800000006', name: '小张', functions: ['admin'], roleLabel: null },
  { id: 7, phone: '13800000007', name: '王建国', functions: ['resident'], roleLabel: null },
  { id: 8, phone: '13800000008', name: '王强', functions: ['relation', 'service'], roleLabel: null },
  { id: 9, phone: '13800000009', name: '刘秀英', functions: ['resident'], roleLabel: null },
];

// ---------------- 老人 ----------------
const elders = [
  {
    id: 1, personId: 1, name: '张桂芳', birthYear: 1948, age: 78, gender: '女',
    addr: '3 栋 201', mode: 'self', monitorLevel: 'monitor', status: 'active',
    phone: '13800000001', createdAt: '2026-10-20 10:00:00',
  },
  {
    id: 2, personId: 7, name: '王建国', birthYear: 1944, age: 82, gender: '男',
    addr: '5 栋 102', mode: 'self', monitorLevel: 'monitor', status: 'active',
    phone: '13800000007', createdAt: '2026-10-20 10:05:00',
  },
  {
    id: 3, personId: 9, name: '刘秀英', birthYear: 1951, age: 75, gender: '女',
    addr: '7 栋 303', mode: 'self', monitorLevel: 'record_only', status: 'active',
    phone: '13800000009', createdAt: '2026-10-20 10:10:00',
  },
];

// ---------------- 关系链 ----------------
const chains = {
  1: {
    layers: [
      {
        level: 1, form: 'accountable', waitMin: 15,
        members: [
          { relationId: 1, personId: 2, name: '李敏', relation: '女儿', isAccountable: true },
          { relationId: 2, personId: 3, name: '李强', relation: '儿子', isAccountable: false },
        ],
      },
      {
        level: 2, form: 'group', waitMin: 30,
        members: [
          { relationId: 3, personId: 4, name: '王姨', relation: '结对志愿者', isAccountable: false },
        ],
      },
      {
        level: 3, form: 'community', waitMin: 30,
        members: [
          { relationId: 4, personId: 5, name: '陈师傅', relation: '社区工作者', isAccountable: false },
        ],
      },
    ],
  },
  2: {
    layers: [
      {
        level: 1, form: 'accountable', waitMin: 15,
        members: [{ relationId: 5, personId: 8, name: '王强', relation: '儿子', isAccountable: true }],
      },
      {
        level: 2, form: 'community', waitMin: 30,
        members: [{ relationId: 6, personId: 5, name: '陈师傅', relation: '社区工作者', isAccountable: false }],
      },
    ],
  },
  3: { layers: [] },
};

// ---------------- 核验单 / 预警 ----------------
const verifyOrders = [
  {
    id: 1024, elderId: 1, elderName: '张桂芳', status: 'pending',
    currentLayer: 1, level: 'L3-high',
    slaDeadline: plusMin(11), slaLeftSec: 660,
    createdAt: plusMin(-4),
    D: 0.78, Q: 0.65,
    signals: [
      { type: 'calendar', label: '今天还没撕日历', at: plusMin(-300), source: '打卡记录', weight: 0.4 },
      { type: 'water', label: '用水量比平时少了 62%', at: plusMin(-180), source: '智能水表', weight: 0.3 },
      { type: 'outdoor', label: '3 天没有出门记录', at: plusMin(-1440), source: '门禁', weight: 0.3 },
    ],
    notifyLog: [
      { layer: 1, toName: '李敏', toPersonId: 2, sentAt: plusMin(-4), readAt: null, ackAt: null },
      { layer: 1, toName: '李强', toPersonId: 3, sentAt: plusMin(-4), readAt: plusMin(-2), ackAt: null },
    ],
    actions: [],
  },
  {
    id: 1023, elderId: 2, elderName: '王建国', status: 'in_progress',
    currentLayer: 2, level: 'L3-mid',
    slaDeadline: plusMin(-2), slaLeftSec: -120,
    createdAt: plusMin(-36),
    D: 0.55, Q: 0.42,
    signals: [
      { type: 'calendar', label: '连续 2 天没确认', at: plusMin(-2880), source: '打卡记录', weight: 0.5 },
      { type: 'call', label: '上次通话距今 9 天', at: plusMin(-12960), source: '通话记录', weight: 0.3 },
    ],
    notifyLog: [
      { layer: 1, toName: '王强', toPersonId: 8, sentAt: plusMin(-36), readAt: plusMin(-35), ackAt: null },
      { layer: 2, toName: '陈师傅', toPersonId: 5, sentAt: plusMin(-21), readAt: null, ackAt: null },
    ],
    actions: [{ action: 'call', at: plusMin(-30), by: '陈师傅' }],
  },
];

// ---------------- 服务单 ----------------
const serviceOrders = [
  {
    id: 2048, elderId: 1, elderName: '张桂芳', type: 'buy', keyType: 'buy',
    title: '想买点米和油', addr: '3 栋 201', status: 'pool',
    createdAt: plusMin(-25), amount: null, audioFileId: 'cloud://mock/a1b2.webm',
    durationSec: 12,
  },
  {
    id: 2047, elderId: 2, elderName: '王建国', type: 'hospital', keyType: 'hospital',
    title: '周四想去医院复查', addr: '5 栋 102', status: 'accepted',
    createdAt: plusMin(-180), amount: null, audioFileId: null, durationSec: 0,
    acceptedBy: '王强', acceptedAt: plusMin(-170),
  },
];

// ---------------- 账单与钱包 ----------------
const bills = [
  {
    id: 301, elderId: 2, elderName: '王建国', orderId: 2046,
    amount: 38.0, status: 'unpaid', createdAt: plusMin(-1440),
    items: '陪同就医 2 小时',
  },
  {
    id: 300, elderId: 1, elderName: '张桂芳', orderId: 2045,
    amount: 22.0, status: 'paid', createdAt: plusMin(-4320), paidAt: plusMin(-4200),
    items: '代购生活用品',
  },
];

const wallet = { personId: 2, balance: 200.0, updatedAt: plusMin(-4200) };

// ---------------- 参数 ----------------
const params = {
  sla_layer1_min: 15,
  sla_layer2_min: 30,
  sla_layer3_min: 30,
  max_layer: 3,
  route_mode: 'chain',            // chain | distance
  distance_rings: '3,5,10',
  merge_window_sec: 30,
  promise_min: 30,
  time_scale: 1,
  enable_voice: true,
  enable_bill: true,
};

// ---------------- 管理端工单 ----------------
const allOrders = [
  ...verifyOrders.map((v) => ({
    id: v.id, type: 'verify', elderName: v.elderName, status: v.status,
    createdAt: v.createdAt, currentLayer: v.currentLayer, slaLeftSec: v.slaLeftSec,
  })),
  ...serviceOrders.map((s) => ({
    id: s.id, type: 'service', elderName: s.elderName, status: s.status,
    createdAt: s.createdAt, currentLayer: null, slaLeftSec: null,
  })),
];

// ---------------- 日历 ----------------
const calendarPages = Array.from({ length: 30 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - i);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return {
    date,
    yi: ['宜静养', '宜散步', '宜访友', '宜晒被', '宜早睡'][i % 5],
    ji: ['忌久坐', '忌贪凉', '忌独行', '忌熬夜', '忌动气'][i % 5],
    hasRequest: i === 2 || i === 7,
    confirmed: i > 0,
  };
});

module.exports = {
  now, plusMin,
  persons, elders, chains, verifyOrders, serviceOrders,
  bills, wallet, params, allOrders, calendarPages,
};
