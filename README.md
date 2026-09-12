# 合租生活管家

给合租室友共用的账本与事务管理工具。四个模块：**账单分摊记账**、**室友与房间管理**、**值日排班**、**公告板 / 公共物品**。

每个室友各自登录，看同一份共享数据。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite + React + TypeScript |
| 后端 | Cloudflare Workers（Hono） |
| 数据库 | Cloudflare D1（SQLite） |
| 部署 | Cloudflare（免费额度内） |

前后端跑在同一个 Worker 里：`/api/*` 进 Worker，其余请求直接返回 Vite 构建出的静态资源。本地开发由 `@cloudflare/vite-plugin` 把 Vite HMR 和本地 D1 合到一个 dev server，不需要手工配 proxy。

## 本地开发

```bash
npm install

# 首次：创建本地数据库表
npm run db:local

# 配置 PIN 哈希密钥（本地用，随便填一个 16 位以上的字符串）
echo "PIN_PEPPER=local-dev-pepper-please-change-me" > .dev.vars

npm run dev          # http://localhost:5173
npm test             # 跑算法与认证单测
```

## 部署

```bash
npx wrangler login                      # 浏览器授权
npx wrangler d1 create hezu-db          # 把输出的 database_id 填进 wrangler.jsonc
npm run db:remote                       # 线上建表
npx wrangler secret put PIN_PEPPER      # 线上密钥，务必换一个高强度随机值
npm run deploy
```

部署后会得到一个 `https://hezu-life-manager.<你的子域>.workers.dev` 链接。

## 两条贯穿全局的约定

**1. 金额一律用整数「分」存储和运算。**

不用浮点数存元。`0.1 + 0.2 !== 0.3` 这类误差在累加多笔账目后会让「谁欠谁多少」直接算不平，且极难排查。只在渲染时除以 100 显示。见 `src/shared/money.ts`。

**2. 分摊明细在写入时物化，不在读取时重算。**

`100 元 ÷ 3 人 = 33.33`，余 1 分。若每次查询重算，余数分配规则一旦调整，历史账目就会跟着漂移。写入时就把每人实际金额定死存进 `expense_shares`，此后只读不算。

## 目录结构

```
src/
├── shared/          前后端共用的纯逻辑（无副作用、无 IO）
│   ├── money.ts       金额换算、均摊的余数分配
│   └── balance.ts     ★ 净余额计算 + 最小转账数算法
├── worker/          后端
│   ├── index.ts       Worker 入口、路由挂载
│   ├── auth.ts        PIN 哈希、会话、限速
│   ├── guards.ts      认证中间件、越权校验
│   ├── ids.ts         ID 与邀请码生成
│   └── routes/        各模块接口
└── client/          前端
test/                单测
schema.sql           D1 建表语句
```

## 几个容易踩的坑（改动前请先读）

- **金额必须走 `yuanToCents()`**，不要用 `parseFloat(x) * 100`。`parseFloat('0.29') * 100 === 28.999999999999996`。
- **结算的符号方向**：转账出去是「还债」，应收回升；收到转账是「被还债」，应收回落。写反会导致还款后欠得更多。`test/balance.test.ts` 里有专门的回归测试。
- **`Σ balance === 0` 是硬断言**。一旦不成立说明分摊数据已损坏，代码会抛错而不是静默算错。
- **每个按 id 操作的接口都要校验 `household_id` 归属**。漏掉就是越权漏洞：任何登录用户都能删别人家的账。
- **PIN 限速是整个认证方案的前提**。PIN 空间很小，没有失败锁定的话，任何人都能在线穷举完所有 PIN。加盐哈希只防「数据库泄露后的离线爆破」，防不住在线穷举。
- **Workers 免费版单请求只有 10ms CPU**，超了直接崩（Error 1102）。PBKDF2 轮数因此定在 25,000（实测 3.38ms），配合不入库的 pepper 保证安全强度。改大之前务必实测。

## 许可

私有项目。
