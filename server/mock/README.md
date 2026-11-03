# Mock API 服务

零依赖，给前端联调用。

**这不是真后端**——没有数据库、没有鉴权，数据在内存里，重启就重置。

## 启动

```bash
node server/mock/index.js

# 换端口
PORT=4000 node server/mock/index.js
```

启动后访问 http://localhost:3000/api/health 确认活着。

## 覆盖范围

`docs/04-接口列表.md` 里的 **45 个 HTTP 接口全部实现**：

| 组 | 数量 | 编号 |
|---|---|---|
| 认证与绑定 | 5 | A1–A5 |
| 老人端 | 7 | E1–E7 |
| 关系人端 | 9 | R1–R9 |
| 处置端 | 10 | H1–H10 |
| 管理端 | 11 | M1–M11 |
| 演示模式 | 3 | D1–D3 |

定时任务 T1–T4 不是 HTTP，这里不实现。

## 假数据

在 `server/mock/data.js` 里，和 `sql/seed.sql` 保持一致：

- **3 位老人**：张桂芳(1) / 王建国(2) / 刘秀英(3)
- **9 个人员**：含 6 个演示账号
- **2 条核验单**：`1024` 待处理（SLA 剩 11 分钟）、`1023` 已超时
- **2 条服务单**：`2048` 在待接池、`2047` 已接单
- **2 张账单**：`301` 待付、`300` 已付

要改数据直接改 `data.js`，重启生效。

## 前端怎么接

```js
const BASE = 'http://localhost:3000/api';

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const { code, data, msg } = await res.json();
  if (code !== 0) throw new Error(msg || '请求失败');
  return data;
}

// 用法
const home = await api('/elder/home');
```

## 和真后端的差别

| 项 | Mock | 真后端 |
|---|---|---|
| 鉴权 | 不校验，任何请求都放行 | JWT，错误 token 返 401 |
| 数据 | 内存，重启重置 | MySQL |
| 幂等 | 不实现 | `clientRequestId` 唯一键 |
| SLA 升级 | 不跑 | 定时任务 T2 |
| 分页 | 支持 `page` / `size` | 同左 |

**前端不要依赖 mock 的宽松行为。** 比如不要假设"随便传什么参数都返回成功"——真后端会做参数校验。

## 什么时候会被替换

`#3`（49 个接口全部注册）完成、`#2`（认证中间件）接上之后，这个 mock 就功成身退。

到时候把 `BASE` 从 `:3000` 换成真后端地址即可，接口结构完全一致。
