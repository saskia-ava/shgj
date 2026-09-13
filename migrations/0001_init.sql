-- 合租生活管家 —— 初始 schema
--
-- ⚠️ 本文件是基线，只含 CREATE，不含 DROP，**创建后永不修改**。
--    后续任何结构变更都新开一个 000N_xxx.sql。
--
-- ⚠️ 文件里不要写任何事务控制语句（BEGIN / COMMIT）。
--    D1 会把整个迁移文件包在一个事务里执行；写 `BEGIN TRANSACTION;` 会被
--    wrangler 剥掉，但写 `BEGIN;` 不会被剥掉，会被原样发给 D1，
--    在已有事务里再开一个事务然后报错。
--
-- ⚠️ wrangler 判断迁移是否跑过，**只比对文件名，不校验内容**。
--    改一个已经应用过的迁移文件，既不会重跑也不会报错——结果是 commit 里的
--    schema 和线上库悄悄不一致，且没有任何信号。已应用的迁移一律不要动。
--
-- ── 贯穿全表的约定 ────────────────────────────────────────────────
--   1. 所有金额字段都是 INTEGER，单位「分」。绝不用 REAL 存元——
--      浮点误差会让「谁欠谁多少」算不平。
--   2. 所有时间字段都是 INTEGER，Unix 毫秒时间戳。
--
-- ── 三层身份 ──────────────────────────────────────────────────────
--   accounts      登录凭据（邮箱 + 密码），**不含任何昵称**
--   members       某个房间里的人，通过 account_id 关联到账号
--   member_pins   房间级的快捷登录 PIN
--
--   一个账号可以属于多个房间，在每个房间里是独立的 members 行，
--   可以有各自不同的名字、房间号、余额。历史账目全部按 members.id 引用，
--   所以名字是「当时那个名字」的快照，不会因为改昵称而漂移。

-- ── 账号 ──────────────────────────────────────────────────────────
-- 刻意不设 nickname 列：账目、分摊、公告全按 members.id 引用，房间内的名字
-- 必须是该房间的历史快照。账号上挂一个昵称，早晚有人拿它渲染房间内姓名，
-- 改一次昵称、多个房间的全部历史账目名字会一起漂移。
-- 顺带的好处：你在 A 房叫「小明」、B 房叫「明哥」，两个社交圈无法被一个
-- 字符串关联起来。
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  -- 存归一化后的小写去空格形式，见 src/shared/email.ts 的 normalizeEmail()
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- ⚠️ 第一阶段（没有域名、发不出邮件）这个标志位永远是 0，且**不阻塞任何功能**。
  --
  --    绝不允许拿未验证的邮箱当身份依据。具体说，将来要加「忘记密码」时，
  --    最顺手的实现是「输入邮箱 → 直接重置密码」——那就成了
  --    「谁抢先用某个邮箱注册，谁就能接管这个账号」。
  --    正确的做法是先验证邮箱归属，再允许基于邮箱的重置。
  email_verified INTEGER NOT NULL DEFAULT 0,
  failed_tries  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_accounts_email ON accounts(email);

-- ── 恢复码 ────────────────────────────────────────────────────────
-- 没有发信能力时，这是唯一能自助找回密码的凭据。注册时一次性生成 8 个，
-- 只显示一次，之后只存哈希。
--
-- 用 SHA-256 而不是 PBKDF2：码本身有 40+ bit 熵（8 位、去掉易混字符的
-- 字母表），不存在被爆破的可能，不需要拉长单次猜测成本——也就不触碰
-- Workers 免费版的 10ms CPU 预算。
CREATE TABLE recovery_codes (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  code_hash  TEXT NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, code_hash)
);

-- ── 合租空间：一个邀请码 = 一个独立账本 ─────────────────────────────
CREATE TABLE households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- ── 室友 ──────────────────────────────────────────────────────────
-- is_active = 0 表示已退租（软删除）。历史账目仍要显示他的名字，
-- 硬删除会让分摊明细变成孤儿数据、账目对不平。
--
-- account_id 可为 NULL：成员可以先由别人代建（还没有账号），之后再认领。
CREATE TABLE members (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  account_id   TEXT REFERENCES accounts(id),
  name         TEXT NOT NULL,
  room         TEXT,
  phone        TEXT,
  move_in      INTEGER,
  move_out     INTEGER,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_members_household ON members(household_id, is_active);
CREATE INDEX idx_members_account ON members(account_id);

-- 同一个账号在同一个房间里最多只能有一条「在住」档案。
-- 两条并存会让余额分裂到两个身份上——而 Σ balance === 0 这个断言
-- 仍然成立，抓不到，用户只会看到两个自己。
--
-- 带 is_active = 1 的部分索引是刻意的：退租后再搬回来是合法路径，
-- 那时旧的 is_active = 0 行不参与唯一性约束。
CREATE UNIQUE INDEX idx_members_account_active
  ON members(account_id, household_id)
  WHERE account_id IS NOT NULL AND is_active = 1;

-- ── 房间级 PIN ────────────────────────────────────────────────────
-- 锚定在 member 上而不是 account 上，理由有两条：
--
-- 1. CPU：PIN 登录的输入是「邀请码 + 我是谁 + PIN」，锚定在成员上才能
--    保证验证路径**恰好跑一次 PBKDF2**。做成账号级的话，要么强制 PIN
--    全局唯一（第二个人想用 1234 会被拒），要么得逐个成员试着校验
--    （N 个成员 N 次 PBKDF2，5 个成员就是 20ms，必然超限）。
-- 2. 语义：PIN 的主张本来就是「我是这个房间里的这个人」。
CREATE TABLE member_pins (
  member_id    TEXT PRIMARY KEY REFERENCES members(id),
  pin_hash     TEXT NOT NULL,
  failed_tries INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
);

-- ── 账目 ──────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  title        TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  category     TEXT NOT NULL,
  paid_by      TEXT NOT NULL REFERENCES members(id),
  spent_on     INTEGER NOT NULL,
  split_type   TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL REFERENCES members(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_expenses_household ON expenses(household_id, spent_on DESC);

-- ── 分摊明细 ──────────────────────────────────────────────────────
-- 均摊也把每人实际金额写死在这里，不在查询时重算。
-- 因为 100 元 ÷ 3 人 = 33.33 余 1 分，余数分配规则一旦变化，
-- 重算就会让历史账目跟着漂移。
CREATE TABLE expense_shares (
  expense_id   TEXT NOT NULL REFERENCES expenses(id),
  member_id    TEXT NOT NULL REFERENCES members(id),
  share_amount INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX idx_shares_member ON expense_shares(member_id);

-- ── 实际转账：用于抵消账目 ────────────────────────────────────────
CREATE TABLE settlements (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  from_member  TEXT NOT NULL REFERENCES members(id),
  to_member    TEXT NOT NULL REFERENCES members(id),
  amount       INTEGER NOT NULL,
  settled_on   INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_settlements_household ON settlements(household_id, settled_on DESC);

-- ── 值日排班 ──────────────────────────────────────────────────────
-- member_ids 是 JSON 数组，记录轮转顺序；next_index 指向当前轮到谁。
--
-- ⚠️ SQLite 无法给 JSON 数组建外键，所以里面的成员 id 是**裸引用**，
--    只能在应用层用 findForeignMembers() 守。删成员行会让它们静默悬空，
--    且 Σ balance === 0 断言检查不出来。
--    这就是「任何迁移都不得改变 members.id」这条纪律的原因。
CREATE TABLE chores (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name         TEXT NOT NULL,
  cycle        TEXT NOT NULL,
  weekday      INTEGER,
  member_ids   TEXT NOT NULL,
  next_index   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_chores_household ON chores(household_id, is_active);

CREATE TABLE chore_logs (
  id         TEXT PRIMARY KEY,
  chore_id   TEXT NOT NULL REFERENCES chores(id),
  member_id  TEXT NOT NULL REFERENCES members(id),
  due_date   INTEGER NOT NULL,
  done_at    INTEGER,
  UNIQUE (chore_id, due_date)
);
CREATE INDEX idx_chore_logs_due ON chore_logs(chore_id, due_date DESC);

-- ── 公告 ──────────────────────────────────────────────────────────
CREATE TABLE announcements (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  author_id    TEXT NOT NULL REFERENCES members(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_ann_household ON announcements(household_id, is_pinned DESC, created_at DESC);

-- ── 公共物品 ──────────────────────────────────────────────────────
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name         TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 0,
  unit         TEXT,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_items_household ON items(household_id);

-- ── 会话 ──────────────────────────────────────────────────────────
-- ⚠️ 这里刻意**不存 member_id**，只存 account_id + active_household_id。
--
--    成员身份每次请求由 (account_id, active_household_id) join members 推导出来。
--    收益是越权自动 fail closed：手工把 active_household_id 改成别人家的房间 id，
--    join 不出成员行 → 直接 403，而不是拿一个不属于自己的身份去查数据。
--
--    active_household_id 为 NULL 表示「已登录但还没选房间」——
--    用户可能把唯一的房间退掉了，这时要引导他去建房或加入，而不是报错。
CREATE TABLE sessions (
  token                TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  active_household_id  TEXT REFERENCES households(id),
  expires_at           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  -- 改密码的二次验证凭证。改密码要验旧密码，但「验旧的 + 算新的」是两次
  -- PBKDF2，会撞上 10ms CPU 上限，所以拆成两个请求：第一个验旧密码并写这个
  -- 字段，第二个在 5 分钟内凭它设置新密码。每次请求仍然只跑一次 PBKDF2。
  password_verified_at INTEGER
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_sessions_account ON sessions(account_id);
