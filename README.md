# 合租生活管家

给合租室友共用的账本与事务管理工具。四个模块：**账单分摊记账**、**室友与房间管理**、**值日排班**、**公告板 / 公共物品**。

每个室友用**邮箱 + 密码**注册后，各自登录、看同一份共享数据。一个账号可以同时属于多个房间，每个房间一套独立的账本，顶部下拉切换。

## 线上地址

**https://hezu-life-manager.hezu-home.workers.dev**

> ⚠️ **中国大陆网络直连打不开。** `*.workers.dev` 这个域名在大陆被 DNS 污染（实测解析到 Facebook 的 IP 段），不是"慢"，是直接连不上。
>
> 想让室友在境内正常使用，需要给 Worker 绑一个**自有域名**（在 Cloudflare 买域名并接入，免费套餐即可）——自有域名不在污染名单里，DNS 由 Cloudflare 自己解析，通常可用。详见「大陆访问」一节。

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
npm test             # 算法与认证单测（77 项）

# 端到端：需要 npm run dev 在另一个终端跑着
npm run test:e2e     # 注册 / 建房 / 记账 / 多房间切换 / 越权 / 改密码 / PIN（110 项）

# 数据完整性。**迁移之后必跑**，有非零项会以退出码 1 结束
npm run db:verify:local
```

> `test:e2e` 会往本地库写测试数据，并且用固定格式的邮箱。重跑前先重置：
> `rm -rf .wrangler/state/v3/d1 && npm run db:local`
> 重置前要先停掉 dev server——它占着 SQLite 文件，Windows 上删不掉。

## 部署

```bash
npx wrangler login                      # 浏览器授权
npx wrangler d1 create hezu-db          # 把输出的 database_id 填进 wrangler.jsonc
npm run db:remote                       # 线上建表
npx wrangler secret put PIN_PEPPER      # 线上密钥，务必换一个高强度随机值
npm run deploy
```

首次部署还需要注册一个 `workers.dev` 子域名（决定链接里的 `<子域>` 那一段，注册后基本不再改）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<账户ID>/workers/subdomain" \
  -H "Authorization: Bearer <OAuth token>" -H "Content-Type: application/json" \
  -d '{"subdomain":"你的子域"}'
```

当前部署在子域 `hezu-home`，得到 `https://hezu-life-manager.hezu-home.workers.dev`。

> `wrangler deploy` 会自动读取 `dist/hezu_life_manager/wrangler.json`（由 Vite 插件生成），不要手动指定 `-c`。它会带上正确的 `main` 和静态资源目录。
>
> 机制是：`vite build` 会写出 `.wrangler/deploy/config.json`，里面指向生成的那份配置，wrangler 在仓库根目录跑时会读它并打印「Using redirected Wrangler configuration」。**这个文件是构建产物，`.gitignore` 里不含它（整个 `.wrangler/` 都被忽略）**，所以任何从干净检出开始的构建（包括 CI）都必须先 `npm run build` 再 `wrangler deploy`。

## CI 自动部署

推送到 `main` 后，GitHub Actions 会自动跑测试、构建、部署。配置在 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)。

**首次启用需要配两个仓库 Secret**（Settings → Secrets and variables → Actions → New repository secret）：

| Secret | 从哪来 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 后台 → My Profile → API Tokens → Create Token → 用 **Edit Cloudflare Workers** 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 后台 → Workers & Pages → 右侧栏的 Account ID |

Token 存在 GitHub 的加密区，不会出现在日志里，也不会进代码。**没配 Secret 之前部署任务会直接报错并提示**，不会静默跳过——失败点在「检查凭据」这一步，此时 `build` 和 `部署` 都被 skip 掉，一行代码都没执行，是设计好的 fail fast。

### Token 的权限只需要 Workers（实测确认）

`wrangler deploy` **只用到 Workers Scripts: Edit**，所以「Edit Cloudflare Workers」模板给的权限是够的，不需要额外加 D1。

实测（2026-09）：一个只有 Workers 权限、没有 D1 权限的 token——

```
GET /accounts/<id>/workers/scripts   → 200   ← 部署要的就是这个
GET /accounts/<id>/d1/database       → 401 Authentication error
```

用**只有这个 token** 的环境跑 `npm run deploy` 成功，版本号正常推进。所以不必为了 CI 去放宽 token 权限。

**但要知道它的边界**：这个 token **跑不了** `npm run db:remote` / `npm run db:verify`（那两个要 D1 权限）。改数据库仍然用本机的 `wrangler login` 登录态，别拿 CI 的 token 替。

⚠️ **建 token 时如果填了 End date，到期那天 CI 会开始失败**，而报错仍然是「检查凭据」那一套，很难联想到是过期。要么设成永不过期，要么把日期记在别处。

⚠️ **`/user/tokens/verify` 认不了 Cloudflare 2026 年新的带前缀格式**（`cfut_` + 40 位 + 8 位校验和 = 53 字符）。拿它验 token 会得到 `6111 Invalid format for Authorization header`，**这不代表 token 有问题**——`wrangler 4.131.1` 能正常识别（`whoami` 会显示「logged in with an User API Token」）。想验就用 `GET /accounts/<id>/workers/scripts`。

CI 里的两处特殊处理，改动前请先理解：

- **测试阈值走环境变量**。`test/auth.test.ts` 里有两条断言本机耗时的金丝雀测试，GitHub 的 runner 比开发机慢，用开发机阈值会误报。CI 里通过 `HZM_CPU_LOCAL_BUDGET_MS: '8'` 放宽。真正防「有人悄悄调高 PBKDF2 轮数」的是那条断言 `PBKDF2_ITERATIONS` 上限的**确定性**测试，与机器快慢无关——放宽计时阈值不影响它的作用。
- **测试与部署是两个 job，各自构建一次**。看起来重复，但部署必须有自己的构建产物：`.wrangler/deploy/config.json` 是 `.` 开头的隐藏路径，`actions/upload-artifact` 默认会丢弃它，用 artifact 传递反而会漏掉。

## 账号体系与多房间

### 三层身份，缺一不可

这是本项目最容易改错的地方。同一件事在三个不同的层次上有三个不同的东西：

| 层 | 表 | 职责 | 关键约束 |
|---|---|---|---|
| **账号** | `accounts` | 邮箱 + 密码。**只有登录凭据，没有任何昵称字段** | 邮箱全局唯一 |
| **关系** | `members.account_id` | 这个房间里的人属于哪个账号 | 同账号同房间最多一条 `is_active = 1` 的档案 |
| **凭证** | `member_pins` | 房间级的 PIN 快捷登录 | 主键是 `member_id`，即「账号 × 房间」 |

**为什么账号上不放昵称**：账目、分摊、结算、公告全部按 `members.id` 引用，名字必须是**当时那个名字的历史快照**。账号上挂个昵称，早晚有人拿它去渲染房间内的姓名，改一次昵称两个房间的全部历史账目名字一起漂移。这和「退租必须软删除」是同一族不变量。顺带得到一个隐私属性：你在 A 房叫「小明」、B 房叫「明哥」，两个社交圈无法被一个字符串关联起来。

**`sessions` 存的是 `account_id` + `active_household_id`，不存 `member_id`。** 成员身份每次请求由这两列 LEFT JOIN `members` 推导：

```sql
SELECT s.account_id, s.active_household_id AS household_id,
       m.id AS member_id, m.name AS member_name
  FROM sessions s
  LEFT JOIN members m
    ON m.account_id = s.account_id
   AND m.household_id = s.active_household_id
   AND m.is_active = 1
 WHERE s.token = ?
```

**这个 LEFT JOIN 本身就是授权检查，不只是查询优化。** 把 `active_household_id` 手工改成别人家的房间 id，join 不出成员行 → 403，而不是拿着一个不属于自己的身份去查数据。`npm run test:e2e` 的第 12 节就是直接改库来验证这条防线（fail closed）。

### ⚠️ 任何一个请求最多只做一次 PBKDF2

这是**结构性**约束，不是记性能小抄：

- 所以**建房 / 加入房间不再顺带设 PIN**——PIN 是建房之后一个独立的可选步骤
- 所以**改密码拆成两个请求**：`POST /auth/password/verify`（验旧的，1 次）→ 5 分钟内 `POST /auth/password`（算新的，1 次）。合并成一个接口的直觉做法是两次 PBKDF2
- PIN 用 1,000 轮，所以「验旧 PIN + 算新 PIN」这个唯一的两段式路径仍然安全（`test/auth.test.ts` 里有一条断言专门守住它不超过一次密码哈希的成本）
- **不做「登录成功时静默重算哈希升级轮数」**——它会给每次成功登录加上第二次 PBKDF2，而且只在成功时触发，是最不容易注意到的路径

**客户端预哈希被明确否决**：它要求把 pepper 下发到浏览器，等于扔掉「数据库泄露也爆破不动」这个核心性质。

#### 但这条规则防的不是你以为的那个东西（2026-09 实测修正）

原始理由是「两次 PBKDF2 会把免费版 10ms CPU 预算吃光」。**实测下来这个前提不成立**，有两个独立的发现：

**一、10ms 上限在这个账号上根本没有被强制。** `wrangler tail` 抓到的 51 个请求里，`register` 跑到 **24ms** 仍然是 `outcome: "ok"`、返回 201。真被掐掉时 `outcome` 会是 `exceededCpu`、响应体是 Error 1102，一次都没出现。（当时 grep `1102` 出来的 10 个「命中」全是 hex 串里的子串，不是错误码。判断依据要看 `outcome`，不是看 CPU 数字。）

**二、CPU 时间和 PBKDF2 轮数几乎无关，大头是 D1 往返。** 稳态（第 3 轮探测）实测：

| 端点 | PBKDF2 | D1 写 | 稳态 CPU |
|---|---|---|---|
| `POST /auth/household` | **0 次** | 3 | 2~6ms（冷启动时 19ms） |
| `POST /auth/pin` | 1×1000 | 1 | 2~3ms |
| `POST /auth/password` | 1×6000 | 1 | 6~8ms |
| `POST /auth/login`（成功） | 1×6000 | 2 | 10~12ms |
| `POST /auth/login`（账号不存在） | 1×6000 | **0** | 2~7ms |

`household` 一次 PBKDF2 都不跑，冷启动时照样 19ms；成功/失败登录跑的是**同一次** PBKDF2(6000)，差值全在写库那两次上。所以如果哪天 10ms 真的开始强制，第一个挂的不是密码端点而是**写库多的业务端点**，靠压 PBKDF2 轮数救不了。

**「≤1 次 PBKDF2」这条规则保留**：它不贵、是免费的保险，而且轮数一旦上去就下不来（老哈希还认）。但不要再用「超了会 Error 1102」当它的理由——真正的理由是「轮数长了是本机测不出来的那种贵」。

**测量方法**（`scripts/measure-cpu.mjs`，`npm run cpu:probe`）：

```bash
# 终端 1：大陆网络下 tail 走 WebSocket，和 HTTP 一样会被墙，必须带代理
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npx wrangler tail --format json
# 终端 2：注意 Node 的 fetch 不自动读 HTTPS_PROXY，也要显式打开
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
  HZM_BASE=https://hezu-life-manager.hezu-home.workers.dev/api node scripts/measure-cpu.mjs
# 至少跑三轮，然后
node scripts/measure-cpu.mjs --report tail.json     # 按端点汇总
node scripts/measure-cpu.mjs --samples tail.json    # 按发生顺序逐条看
```

**为什么要跑三轮**：一轮里每个端点只有 1 个样本，冷启动的摊销全落在那轮的头几个请求上，`register` 看起来就是 24ms；到第 3 轮才降到 15ms 以下。`--samples` 就是用来分辨冷启动和真实成本的——同一点连着几轮一路下降是冷启动，一直高才是真贵。
**一条都没抓到时脚本会报错退出而不是报绿**：tail 连不上或者探测没跑都会得到空文件，此时打印「全部低于 10ms」和真的达标长得一模一样。

### 恢复码

这是**第五期（邮件）之前唯一能自助找回密码的途径**。注册时一次性显示 8 个 `XXXX-XXXX`，数据库里只存 SHA-256，之后谁也拿不回来。

- 每个码只能用一次
- 弄丢了可以在「室友」页底部用密码换一批新的，**旧的立即全部作废**
- 恢复码只有 40+ bit 熵，够用是因为它只在「知道邮箱」的前提下使用，且失败会走同一套限速

**丢 pepper 是灾难性的**：`PIN_PEPPER` 一旦丢失，所有人既登不上也无法运维重置（密码和 PIN 全部依赖它派生）。本地值在 `.dev.vars`，线上用 `wrangler secret put PIN_PEPPER`，另有一份备份在 `.pin-pepper.backup.txt`（`.gitignore` 里配了 `.pin-pepper*`）。**这三处至少要有两处同时存在。**

## 数据库迁移

用的是 D1 原生迁移（`wrangler d1 migrations`），没有引入 ORM。

```
npm run db:new "描述"     # 生成 migrations/NNNN_描述.sql
npm run db:local          # 应用到本地
npm run db:remote         # 应用到线上
npm run db:verify         # 应用后核对表/索引/悬空引用，有非零项则退出码 1
```

### 三条纪律

1. **`0001_init.sql` 之后永不修改。** 它是纯 CREATE，不含任何 DROP，是整条迁移链的基线。

   **注意它的内容是「第二期之后」的状态**：`accounts` / `member_pins` / `recovery_codes`、`sessions` 的 `account_id` + `active_household_id`、`idx_members_account_active` 部分唯一索引都已经在里面了，**不存在 `0002`**。

   这是刻意的。第二期走的是「线上清库重建」而不是写数据迁移（理由见下），所以基线被**一次性重写**成重建后的形状，然后冻结。下次要加表，从 `0002` 开始建。

   > 为什么当初选重建而不是写迁移：`expenses.created_by` 和 `chores.member_ids` 是**裸引用**，写迁移时任何一次重建 member 行都会让它们静默悬空，而 `Σ balance === 0` 这个断言检查不出来。趁库还只有冒烟测试数据时重建，是唯一能免费补上这两处约束的机会。

   重建的完整顺序（已执行过一次，`scripts/reset-remote-db.sql` 里也写着）：

   ```bash
   npx wrangler d1 export hezu-db --remote --output=backup-before-rebuild.sql
   # ⚠️ 先打开备份看一眼再删。上次导出里是 23 个 @example.com 测试账号、
   #    0 个真实用户——"确认里面只有测试数据"这一步不能省
   npx wrangler d1 execute hezu-db --remote --file=./scripts/reset-remote-db.sql
   npm run db:remote && npm run db:verify && npm run test:e2e
   ```

   `reset-remote-db.sql` **绝不能**放进 `migrations/`——放进去的话，任何人重置 `d1_migrations` 后跑 `migrations apply`，它会真的执行并清空生产库，而且看起来就像一次正常的迁移。它必须连 `d1_migrations` 一起删：不删的话 `migrations apply` 会输出「✅ No more migrations to apply」然后给你留下一张空库，**这个失败模式看起来完全像成功**。
2. **已应用的迁移文件禁止修改内容。** wrangler 只比对**文件名**，不存校验和。改内容既不重跑也不报错，结果是 commit 里的 schema 和线上库不一致，**且没有任何信号**。要改就新建一个迁移。
3. **文件里不写任何事务控制语句。** D1 会把整个迁移文件包在一个事务里；写 `BEGIN TRANSACTION;` 会被 wrangler 剥掉，写 `BEGIN;` 不会被剥掉，会被原样发给 D1 在已有事务里再开一个事务然后报错。

### 还有一条，关于 `members.id`

**任何迁移都不得改变 `members.id`。** `expenses.created_by` 和 `chores.member_ids`（JSON 数组）是裸引用，重建 member 行会让它们静默悬空，而 `Σ balance === 0` 这个断言**检查不出来**——余额还是平的，只是挂在了不存在的人身上。`npm run db:verify` 里的 `orphan chores.member_ids` 是唯一能发现它们的办法（`json_each` 是唯一能查 JSON 数组里悬空 id 的手段）。

### ⚠️ D1 的复合 SELECT 上限是 5 项，不是 SQLite 默认的 500

把一堆检查写成一个大 `UNION ALL` 会直接报 `too many terms in compound SELECT`，**整条语句被丢掉，一行结果都出不来**。实测 3/4/5 项通过、6 项开始报错。

所以 `scripts/verify-integrity.sql` 拆成了多条语句，每条的 `UNION ALL` 项数 ≤ 5；表名和索引名那两组改用 `json_each('[...]')` 驱动清单，项数不随检查数量增长。`scripts/verify-integrity.mjs` 会核对总项数（期望 27），项数不对就报错——防止有人日后又把它们合并回去。

## 两条贯穿全局的约定

**1. 金额一律用整数「分」存储和运算。**

不用浮点数存元。`0.1 + 0.2 !== 0.3` 这类误差在累加多笔账目后会让「谁欠谁多少」直接算不平，且极难排查。只在渲染时除以 100 显示。见 `src/shared/money.ts`。

**2. 分摊明细在写入时物化，不在读取时重算。**

`100 元 ÷ 3 人 = 33.33`，余 1 分。若每次查询重算，余数分配规则一旦调整，历史账目就会跟着漂移。写入时就把每人实际金额定死存进 `expense_shares`，此后只读不算。

## 目录结构

```
migrations/          D1 迁移（唯一改 schema 的地方，0001_init.sql 是基线）
scripts/
├── verify-integrity.sql    完整性检查语句
├── verify-integrity.mjs    跑上面的 SQL 并断言全为 0
└── e2e-phase2.mjs          账号体系 / 多房间端到端
src/
├── shared/          前后端共用的纯逻辑（无副作用、无 IO）
│   ├── money.ts       金额换算、均摊的余数分配
│   ├── balance.ts     ★ 净余额计算 + 最小转账数算法
│   ├── email.ts       邮箱规范化与校验
│   └── errors.ts      机器可读的错误码（前端据此分流）
├── worker/          后端
│   ├── index.ts       Worker 入口、路由挂载
│   ├── auth.ts        ★ 哈希、会话、限速、恢复码
│   ├── guards.ts      认证中间件、越权校验
│   ├── ids.ts         ID / 邀请码 / 恢复码生成
│   └── routes/        各模块接口
└── client/          前端
    ├── api.ts         唯一的网络层，也是 Session 类型的定义处
    └── pages/         各页面；AuthPage 未登录、HouseholdGate 未选房间
test/                单测
```

前端有**三态**，不是两态：

```tsx
if (!session)                              return <AuthPage />;         // 匿名
if (!session.household || !session.member) return <HouseholdGate />;   // 登录了，没选房间
return <AppContext.Provider key={householdId}>…</AppContext.Provider>; // 正常使用
```

`HouseholdGate` 必须有**三个**出口（选已有 / 建新房 / 用邀请码加入）。只给「选已有房间」的话，用户把唯一的房间退掉之后会看到一张空列表，然后**没有任何办法回到主界面**——连退出登录都要另给一条路。同理，它拿到的 `onLogout` 必须是 App 的 `logout()` 而不是 `reloadSession()`：登出后 `api.me()` 必然 401，`reloadSession` 会静默失败，用户点了退出却还停在原地。

## 几个容易踩的坑（改动前请先读）

- **金额必须走 `yuanToCents()`**，不要用 `parseFloat(x) * 100`。`parseFloat('0.29') * 100 === 28.999999999999996`。
- **结算的符号方向**：转账出去是「还债」，应收回升；收到转账是「被还债」，应收回落。写反会导致还款后欠得更多。`test/balance.test.ts` 里有专门的回归测试。
- **`Σ balance === 0` 是硬断言**。一旦不成立说明分摊数据已损坏，代码会抛错而不是静默算错。
- **每个按 id 操作的接口都要校验 `household_id` 归属**。漏掉就是越权漏洞：任何登录用户都能删别人家的账。
- **PIN 限速是整个认证方案的前提**。PIN 空间很小，没有失败锁定的话，任何人都能在线穷举完所有 PIN。加盐哈希只防「数据库泄露后的离线爆破」，防不住在线穷举。
- **认领成员档案必须用条件 UPDATE + 检查 `meta.changes`**，绝不能写成「先 SELECT 再 UPDATE」。两个请求同时认领同一条档案时，后者会顶替前者并**继承对方的余额**。`WHERE account_id IS NULL` 是唯一能挡住这件事的地方。
- **加入房间时要连「已退租」的旧档案一起找。** 只查在住的话，退租再搬回来会新建一条身份，历史账目留在一条他已经够不着的旧身份上——`Σ balance === 0` 依然成立（退租者仍参与计算），但他自己的欠款在界面上凭空消失。部分唯一索引 `idx_members_account_active` 只约束 `is_active = 1`，正是为了让这条路复用同一条 `members.id`。
- **同名成员要拦住。** 不拦会静默建出第二个「小红」，账目仍然算得对（成员 id 不同），但 PIN 登录页会让用户在两个一模一样的名字里猜哪个是自己。注意这是「要求加区分」而不是「禁止同名」。
- **选轮数不能信本机基准**——本机 Node 比 Cloudflare 快约 3 倍：25,000 轮在本机是 3.3ms（看着很安全），线上实测却是 10~14ms。现在定在 6,000 轮。
  改轮数前必须先线上实测 `cpuTime`（`npm run cpu:probe` + `wrangler tail`，见下节），别照本机数字拍脑袋。轮数写在哈希串里，改动不会让老哈希失效。
- **实测发现 CPU 大头不是 PBKDF2，是 D1 写。** 见下节，这条改变了「该防什么」的判断。

## 已知限制

**多标签页共享同一个 cookie。** 在标签页 A 切到另一个房间，标签页 B 并不知道，会继续往它记忆中的旧房间写数据。

已经做的缓解：切房时 `AppContext.Provider` 上的 `key={householdId}` 会强制整棵子树卸载重建（所有页面的 `useState` 归零，避免「切到 B 房但记账页还预填着 A 房成员」）；标签页重新可见时会重新拉一次 `/me` 对账。

**但这只解决了「切回来的时候能发现」，切过去的瞬间仍可能往错的房间写一两条。** 彻底解决需要跨标签页通信（`BroadcastChannel` + 写操作前校验），成本远大于收益，所以不做，写成已知问题而不是假装不存在。

**邮箱是否注册过，可以从响应耗时枚举出来。** `POST /auth/login` 在账号不存在时会对一个假哈希跑一次等价的 PBKDF2（`dummyVerify`），把 PBKDF2 那一段的耗时拉平——**但那只是成功路径上的一小部分**。账号存在时还要 `clearFailedAttempts`（UPDATE）、`createSession`（INSERT）、`buildSessionPayload`（若干 SELECT），不存在时一次写都没有。

线上实测（2026-09，40 次交替采样）：

```
账号存在    min 385.7ms   p50 403.1ms
账号不存在  min 265.5ms   p50 282.9ms
            ↑ 中位数差 120.2ms，最小值的差 120.3ms —— 差值稳定，不是抖动
```

两组的最值有重叠（成功组最慢 969ms，失败组最快 265ms），但重复采样十几次取中位数就能稳定区分。

**为什么不修**：彻底的修法是让失败路径也做一次等价的写（比如插入一行再删掉）。那等于给未认证请求开放 D1 写放大——任何人都能用不存在的邮箱刷写操作，而 D1 的写是这套架构里最贵的资源。用「未认证可触发的写放大」换「邮箱存在性保密」不划算。

真实的危害有限：知道某个邮箱注册过，并不带来密码（有 pepper + 6,000 轮 PBKDF2 + 5 次失败锁定 15 分钟）。所以这里如实记录，而不是留一句看起来在防、实际没防住的注释。

**`NO_MEMBERSHIP` 不能当成 401 处理。** 它表示「登录着，但当前房间下没有身份」（还没选房间，或已退租）。当成 401 会把人踢回登录页，而**他重登一次会回到完全一样的状态，永远出不来**。前端按错误码分流到「回房间选择页」。

## 大陆访问

Cloudflare 在中国大陆没有边缘节点，且 `*.workers.dev` / `*.pages.dev` 这两个共享域名被 DNS 污染。实测（2026-09）：

```
hezu-life-manager.hezu-home.workers.dev
  直连            → 超时，连不上
  DNS 解析        → 128.242.240.221 / 2a03:2880:...:face:b00c:...（Facebook IP 段，典型的污染响应）
  走代理          → HTTP 200，1.9s

cloudflare.com（Cloudflare 自家域名）
  DNS 解析        → 2606:4700::...（真实 Cloudflare 段，正常）
```

结论：**被污染的是 `workers.dev` 这个域名，不是 Cloudflare 的 IP。** 因此绑自有域名是有效的解法。

| 方案 | 成本 | 大陆可用性 |
|---|---|---|
| 现状（`*.workers.dev`） | 0 | ❌ 直连不通，必须挂代理 |
| **绑定自有域名**（域名接入 Cloudflare） | 域名约 30~70 元/年 | ✅ 通常可用，速度中等 |
| 自有域名 + 国内云备案 | 服务器 + 域名 + 1~3 周备案 | ✅ 最快 |

绑自有域名的做法：买好域名 → 在 Cloudflare 添加站点（免费套餐）→ 把域名的 NS 指向 Cloudflare → 在 `wrangler.jsonc` 里加：

```jsonc
"routes": [
  { "pattern": "hezu.你的域名.com", "custom_domain": true }
]
```

再 `npm run deploy` 即可。域名不变，之后所有迭代都在这一个域名下更新。

## 许可与可见性

代码托管在公开仓库 [saskia-ava/shgj](https://github.com/saskia-ava/shgj)，**任何人可见**。

但「公开可见」不等于「授权使用」：本项目**未授予任何使用许可**（All rights reserved）。你可以阅读代码，但未经许可不得复制、修改、分发或用于自己的项目。

之所以公开而不加密，是因为仓库里**不含任何密钥**——`PIN_PEPPER` 走的是 `.dev.vars`（本地）和 `wrangler secret`（线上），两者都在 `.gitignore` 里，从未进入版本历史。源码公开不会导致任何人的数据被访问。

> 如果你后来改主意想转为私有仓库：GitHub 仓库 Settings → General → 页面底部 Danger Zone → Change visibility → Private。**改可见性不影响 Cloudflare 部署和线上链接**，网站照常对外服务。
