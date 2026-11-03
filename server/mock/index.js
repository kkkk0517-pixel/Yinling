#!/usr/bin/env node
/**
 * 银铃 · Mock API 服务
 *
 * 零依赖，直接跑：  node server/mock/index.js
 * 默认端口 3000，可用 PORT 环境变量改：PORT=4000 node server/mock/index.js
 *
 * 覆盖 docs/04-接口列表.md 中全部 45 个 HTTP 接口（A1–A5 / E1–E7 / R1–R9 /
 * H1–H10 / M1–M11 / D1–D3）。定时任务 T1–T4 不是 HTTP，这里不实现。
 *
 * 返回格式统一为 { code, data, msg }，与真实后端一致。
 * 不做鉴权：任何请求都当作管理员，方便前端联调。
 */

const http = require('http');
const D = require('./data');

const PORT = Number(process.env.PORT || 3000);

// ---------------- 响应包装 ----------------
const ok = (data) => ({ code: 0, data, msg: '' });
const err = (code, msg) => ({ code, data: null, msg });

const page = (list, q) => {
  const p = Math.max(1, Number(q.page || 1));
  const size = Math.max(1, Number(q.size || 20));
  return { list: list.slice((p - 1) * size, p * size), total: list.length };
};

const elderOf = (id) => D.elders.find((e) => e.id === Number(id)) || D.elders[0];
const personOf = (id) => D.persons.find((p) => p.id === Number(id)) || D.persons[0];

// ---------------- 路由表 ----------------
// [method, path, handler(ctx)]
// ctx = { params, query, body }
const ROUTES = [
  // ===== 一、认证与绑定 =====
  ['POST', '/api/auth/sms-code', () => ok({ sent: true, devCode: '123456' })],

  ['POST', '/api/auth/login', ({ body }) => {
    const person = D.persons.find((p) => p.phone === body.phone) || D.persons[1];
    const isResident = person.functions.includes('resident');
    return ok({
      token: 'mock-token-' + person.id,
      person: { id: person.id, name: person.name, phone: person.phone },
      functions: person.functions,
      elders: isResident
        ? D.elders.filter((e) => e.personId === person.id)
        : D.elders.filter((e) => (D.chains[e.id]?.layers || []).some((l) => l.members.some((m) => m.personId === person.id))),
    });
  }],

  ['GET', '/api/auth/me', () => ok({
    person: { id: 2, name: '李敏', phone: '13800000002' },
    functions: ['relation', 'service'],
    elders: [D.elders[0]],
    roleLabels: { relation: '家属', service: '服务承接人' },
  })],

  ['POST', '/api/auth/invite', ({ body }) => ok({
    code: '482913',
    expiresAt: D.plusMin(7 * 24 * 60),
    elderId: body.elderId || 1,
  })],

  ['POST', '/api/auth/bind', () => ok({ elderId: 1, elderName: '张桂芳' })],

  // ===== 二、老人端 =====
  ['GET', '/api/elder/home', () => ok({
    todayConfirmed: false,
    calendar: { yi: '宜静养', ji: '忌久坐', totalPages: 128, streak: 6 },
    recentVisit: { at: D.plusMin(-2880), by: '李敏', note: '来看过您，带了水果' },
    pendingRequest: { id: 2048, title: '想买点米和油', createdAt: D.plusMin(-25) },
    promise: '一般 30 分钟内有人联系您',
  })],

  ['POST', '/api/elder/calendar/confirm', () => ok({
    confirmedAt: D.now(), totalPages: 129, streak: 7,
  })],

  ['GET', '/api/elder/calendar', ({ query }) => ok({
    month: query.month || D.now().slice(0, 7),
    pages: D.calendarPages,
  })],

  ['POST', '/api/elder/audio', () => ok({
    fileId: 'cloud://mock/' + Date.now() + '.webm',
    duration: 8,
  })],

  ['POST', '/api/elder/requests', ({ body }) => ok({
    orderId: 2050,
    promise: '今天之内有人联系您',
    canCancelUntil: D.plusMin(10),
    keyType: body.keyType || 'buy',
    audioFileId: body.audioFileId || null,
  })],

  ['POST', '/api/elder/emergency', () => ok({
    orderId: 1025,
    promise: '已通知所有联系人，请稍等',
    broadcast: true,
  })],

  ['POST', /^\/api\/elder\/requests\/(\d+)\/cancel$/, ({ params }) => ok({
    ok: true, orderId: Number(params[0]),
  })],

  // ===== 三、关系人端 =====
  ['GET', '/api/relation/home', () => ok({
    elders: D.elders.filter((e) => e.id !== 3).map((e) => ({
      id: e.id, name: e.name, age: e.age, addr: e.addr,
      statusLine: e.id === 1 ? '今天还没消息' : '今天已确认',
    })),
    mergedNotification: {
      id: 1024, elderId: 1, elderName: '张桂芳',
      reason: '今天还没撕日历，用水也比平时少',
      createdAt: D.plusMin(-4), isAccountable: true,
    },
    bills: D.bills.filter((b) => b.status === 'unpaid'),
  })],

  ['GET', /^\/api\/relation\/notifications\/(\d+)$/, ({ params }) => {
    const v = D.verifyOrders.find((x) => x.id === Number(params[0])) || D.verifyOrders[0];
    return ok({
      id: v.id,
      elder: elderOf(v.elderId),
      reasons: v.signals.map((s) => s.label),
      lastService: { at: D.plusMin(-4320), content: '代购生活用品' },
      isAccountable: true,
      slaLeftSec: v.slaLeftSec,
      buttons: [
        { key: 'ok_visited', label: '我去看过了' },
        { key: 'ok_called', label: '我打过电话了' },
        { key: 'unreachable', label: '联系不上' },
      ],
    });
  }],

  ['POST', /^\/api\/relation\/notifications\/(\d+)\/ack$/, ({ params, body }) => {
    const v = D.verifyOrders.find((x) => x.id === Number(params[0]));
    if (v) {
      v.notifyLog = v.notifyLog.map((n) => (n.toPersonId === 2 ? { ...n, ackAt: D.now() } : n));
      v.slaLeftSec = null; // 主责回执 → 停计时
    }
    return ok({ ok: true, escalated: false, result: body.result || 'ok_called' });
  }],

  ['GET', /^\/api\/relation\/elders\/(\d+)\/brief$/, ({ params }) => ok({
    elderId: Number(params[0]),
    checkInDays: { confirmed: 5, total: 7 },
    lastService: { at: D.plusMin(-4320), content: '代购生活用品', source: '服务记录' },
    lastConfirm: { at: D.plusMin(-1500), by: '李敏', source: '回执记录' },
    openOrders: [{ id: 2048, title: '想买点米和油', status: 'pool' }],
  })],

  ['GET', '/api/relation/bills', ({ query }) => {
    const list = query.status ? D.bills.filter((b) => b.status === query.status) : D.bills;
    return ok({ list, balance: D.wallet.balance });
  }],

  ['POST', /^\/api\/relation\/bills\/(\d+)\/pay$/, ({ params }) => {
    const b = D.bills.find((x) => x.id === Number(params[0]));
    if (b && b.status === 'unpaid') {
      D.wallet.balance = Number((D.wallet.balance - b.amount).toFixed(2));
      b.status = 'paid';
      b.paidAt = D.now();
    }
    return ok({ ok: true, balance: D.wallet.balance });
  }],

  ['POST', '/api/relation/wallet/recharge', ({ body }) => {
    D.wallet.balance = Number((D.wallet.balance + Number(body.amount || 0)).toFixed(2));
    return ok({ balance: D.wallet.balance });
  }],

  ['POST', /^\/api\/relation\/service-orders\/(\d+)\/accept$/, ({ params }) => {
    const o = D.serviceOrders.find((x) => x.id === Number(params[0]));
    if (o) { o.status = 'accepted'; o.acceptedBy = '李敏'; o.acceptedAt = D.now(); }
    return ok({ ok: true, order: o || D.serviceOrders[0] });
  }],

  ['POST', /^\/api\/relation\/service-orders\/(\d+)\/decline$/, ({ params, body }) => {
    const o = D.serviceOrders.find((x) => x.id === Number(params[0]));
    if (o) o.status = 'pool';
    return ok({ ok: true, nextStep: '已退回待接池，会继续找其他人', reason: body.reason || null });
  }],

  // ===== 四、处置端 =====
  ['GET', '/api/agent/workbench', () => ok({
    mine: D.verifyOrders.filter((v) => v.status !== 'closed'),
    pool: D.serviceOrders.filter((s) => s.status === 'pool'),
    elders: D.elders.filter((e) => e.monitorLevel === 'monitor'),
    overdueCount: D.verifyOrders.filter((v) => (v.slaLeftSec ?? 0) < 0).length,
  })],

  ['GET', /^\/api\/agent\/verify-orders\/(\d+)$/, ({ params }) => {
    const v = D.verifyOrders.find((x) => x.id === Number(params[0])) || D.verifyOrders[0];
    return ok({
      id: v.id,
      elder: elderOf(v.elderId),
      alert: { D: v.D, Q: v.Q, level: v.level, createdAt: v.createdAt },
      signals: v.signals,
      notifyLog: v.notifyLog,
      slaLeft: v.slaLeftSec,
      actions: [
        { key: 'call', label: '打电话' },
        { key: 'visit', label: '去家里' },
        { key: 'escalate', label: '转上级' },
      ],
    });
  }],

  ['POST', /^\/api\/agent\/verify-orders\/(\d+)\/action$/, ({ params, body }) => {
    const v = D.verifyOrders.find((x) => x.id === Number(params[0]));
    if (v) v.actions.push({ action: body.action || 'visit', at: D.now(), by: '陈师傅' });
    return ok({ ok: true, methodAutoFilled: body.action === 'visit' ? 'visit' : 'call' });
  }],

  ['POST', /^\/api\/agent\/verify-orders\/(\d+)\/disposition$/, ({ params, body }) => {
    const v = D.verifyOrders.find((x) => x.id === Number(params[0]));
    if (v) {
      v.status = 'closed';
      v.slaLeftSec = null;
      v.disposition = {
        resultCode: body.resultCode || 'normal',
        method: body.method || 'visit',
        note: body.note || '',
        at: D.now(),
        // 服务端算，前端不传
        durationMin: 22,
        isInvalidCheck: ['normal', 'declined'].includes(body.resultCode) ? 1 : 0,
      };
    }
    return ok({ ok: true, orderId: Number(params[0]) });
  }],

  ['POST', /^\/api\/agent\/verify-orders\/(\d+)\/transfer$/, ({ params, body }) => ok({
    ok: true, orderId: Number(params[0]), toPersonId: body.toPersonId || 5,
  })],

  ['GET', '/api/agent/service-orders', ({ query }) => ok({
    list: D.serviceOrders,
    sortedBy: query.lat ? 'distance' : 'createdAt',
  })],

  ['POST', /^\/api\/agent\/service-orders\/(\d+)\/accept$/, ({ params }) => {
    const o = D.serviceOrders.find((x) => x.id === Number(params[0]));
    if (o) { o.status = 'accepted'; o.acceptedBy = '陈师傅'; }
    return ok({ ok: true });
  }],

  ['POST', /^\/api\/agent\/service-orders\/(\d+)\/start$/, ({ params }) => {
    const o = D.serviceOrders.find((x) => x.id === Number(params[0]));
    if (o) o.status = 'started';
    return ok({ ok: true, startedAt: D.now() });
  }],

  ['POST', /^\/api\/agent\/service-orders\/(\d+)\/complete$/, ({ params, body }) => {
    const o = D.serviceOrders.find((x) => x.id === Number(params[0]));
    if (o) o.status = 'done';
    let billId = null;
    if (body.amount) {
      billId = 400 + Math.floor(Math.random() * 100);
      D.bills.unshift({
        id: billId, elderId: o ? o.elderId : 1, elderName: o ? o.elderName : '张桂芳',
        orderId: Number(params[0]), amount: Number(body.amount), status: 'unpaid',
        createdAt: D.now(), items: body.content || '服务完成',
      });
    }
    return ok({ ok: true, billId });
  }],

  ['GET', /^\/api\/agent\/elders\/(\d+)$/, ({ params }) => {
    const e = elderOf(params[0]);
    return ok({
      elder: e,
      chain: D.chains[e.id] || { layers: [] },
      history: [
        { id: 1020, type: 'verify', at: D.plusMin(-10080), result: 'normal' },
        { id: 2045, type: 'service', at: D.plusMin(-4320), result: 'done' },
      ],
    });
  }],

  // ===== 五、管理端 =====
  ['GET', '/api/admin/overview', () => ok({
    alerts: 12,
    invalidChecks: 8,
    familyAckRate: 0.68,
    avgResponseMin: 23.5,
    note: '台账口径，与问卷自报不可比；无效核查 = 结论为「没事」或「拒单」的单',
    pendingCount: 3,
    overdueCount: 1,
    unreadCount: 2,
    lastJobAt: D.plusMin(-1),
  })],

  ['GET', '/api/admin/elders', ({ query }) => {
    let list = D.elders;
    if (query.q) list = list.filter((e) => e.name.includes(query.q));
    if (query.level) list = list.filter((e) => e.monitorLevel === query.level);
    if (query.status) list = list.filter((e) => e.status === query.status);
    return ok(page(list, query));
  }],

  ['POST', '/api/admin/elders', ({ body }) => ok({
    elderId: 100 + Math.floor(Math.random() * 100),
    name: body.name, monitorLevel: body.monitorLevel || 'record_only',
  })],

  ['PATCH', /^\/api\/admin\/elders\/(\d+)$/, ({ params, body }) => {
    const e = D.elders.find((x) => x.id === Number(params[0]));
    if (e) Object.assign(e, body);
    return ok({ ok: true });
  }],

  ['GET', /^\/api\/admin\/elders\/(\d+)\/chain$/, ({ params }) => ok(
    D.chains[Number(params[0])] || { layers: [] }
  )],

  ['PUT', /^\/api\/admin\/elders\/(\d+)\/chain$/, ({ params, body }) => {
    D.chains[Number(params[0])] = { layers: body.layers || [] };
    return ok({ ok: true, affected: (body.layers || []).reduce((n, l) => n + (l.members || []).length, 0) });
  }],

  ['GET', '/api/admin/params', () => ok({ params: D.params })],

  ['PUT', '/api/admin/params', ({ body }) => {
    const whitelist = Object.keys(D.params);
    Object.entries(body).forEach(([k, v]) => {
      if (whitelist.includes(k)) D.params[k] = v;
    });
    return ok({ ok: true, params: D.params });
  }],

  ['GET', '/api/admin/orders', ({ query }) => {
    let list = D.allOrders;
    if (query.type) list = list.filter((o) => o.type === query.type);
    if (query.status) list = list.filter((o) => o.status === query.status);
    return ok(page(list, query));
  }],

  ['GET', /^\/api\/admin\/orders\/(\d+)$/, ({ params }) => {
    const id = Number(params[0]);
    const v = D.verifyOrders.find((x) => x.id === id);
    return ok({
      order: v || D.serviceOrders.find((x) => x.id === id) || D.verifyOrders[0],
      events: (v?.actions || []).map((a, i) => ({ seq: i + 1, ...a })),
      disposition: v?.disposition || null,
    });
  }],

  ['PUT', /^\/api\/admin\/users\/(\d+)\/role-label$/, ({ params, body }) => {
    const p = D.persons.find((x) => x.id === Number(params[0]));
    if (p) p.roleLabel = body.roleLabel || null;
    return ok({ ok: true });
  }],

  // ===== 六、演示模式 =====
  ['POST', '/api/demo/reset', () => ok({
    ok: true, elders: D.elders.length, relations: Object.values(D.chains).reduce((n, c) => n + c.layers.reduce((m, l) => m + l.members.length, 0), 0),
    tookMs: 820,
  })],

  ['POST', '/api/demo/trigger', ({ body }) => ok({
    alertId: 9000 + Math.floor(Math.random() * 100),
    orderId: 9000 + Math.floor(Math.random() * 100),
    elderId: body.elderId || 1,
    createdAt: D.now(),
  })],

  ['PUT', '/api/demo/time-scale', ({ body }) => {
    D.params.time_scale = Number(body.scale || 1);
    return ok({ ok: true, scale: D.params.time_scale });
  }],
];

// ---------------- 路由匹配 ----------------
function match(method, pathname) {
  for (const [m, p, handler] of ROUTES) {
    if (m !== method) continue;
    if (typeof p === 'string') {
      if (p === pathname) return { handler, params: [] };
    } else {
      const hit = p.exec(pathname);
      if (hit) return { handler, params: hit.slice(1) };
    }
  }
  return null;
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(url.searchParams.entries());

  // 健康检查
  if (pathname === '/api/health') {
    res.writeHead(200);
    return res.end(JSON.stringify(ok({
      status: 'ok', mode: 'mock', uptimeSec: Math.floor(process.uptime()), time: D.now(),
    })));
  }

  // 收集 body
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = {}; }
    }

    const hit = match(req.method, pathname);
    if (!hit) {
      res.writeHead(404);
      return res.end(JSON.stringify(err(404, `mock 未实现: ${req.method} ${pathname}`)));
    }

    try {
      const result = hit.handler({ params: hit.params, query, body });
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify(err(500, String(e && e.message ? e.message : e))));
    }
  });
});

server.listen(PORT, () => {
  const total = ROUTES.length;
  console.log('');
  console.log('  银铃 Mock API 已启动');
  console.log('  http://localhost:' + PORT + '/api/health');
  console.log('  已实现 ' + total + ' 个接口（docs/04 全量 45 个 HTTP 接口）');
  console.log('  数据：3 位老人 / 9 个人员 / 2 条核验单 / 2 条服务单');
  console.log('');
  console.log('  试一下：');
  console.log('    curl http://localhost:' + PORT + '/api/admin/overview');
  console.log('    curl http://localhost:' + PORT + '/api/elder/home');
  console.log('    curl http://localhost:' + PORT + '/api/agent/workbench');
  console.log('');
});
