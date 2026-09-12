-- 合租生活管家 —— D1 (SQLite) schema
--
-- 两条贯穿全表的约定：
--   1. 所有金额字段都是 INTEGER，单位「分」。绝不用 REAL 存元——
--      浮点误差会让「谁欠谁多少」算不平。
--   2. 所有时间字段都是 INTEGER，Unix 毫秒时间戳。
--
-- 建表：npx wrangler d1 execute hezu-db --local --file=./schema.sql

-- ── 合租空间：一个邀请码 = 一个独立账本 ─────────────────────────────
CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- ── 室友 ──────────────────────────────────────────────────────────
-- is_active = 0 表示已退租（软删除）。历史账目仍要显示他的名字，
-- 硬删除会让分摊明细变成孤儿数据、账目对不平。
CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id),
  name          TEXT NOT NULL,
  room          TEXT,
  phone         TEXT,
  move_in       INTEGER,
  move_out      INTEGER,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- PIN 用 PBKDF2 加盐哈希。4 位 PIN 只有 1 万种组合，
  -- 没有 pin_salt 就意味着可被彩虹表瞬间穷举。
  pin_hash      TEXT,
  pin_salt      TEXT,
  -- 暴力破解防护：失败累计 5 次锁定 15 分钟
  failed_tries  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_household ON members(household_id, is_active);

-- ── 账目 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  title        TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  category     TEXT NOT NULL,
  paid_by      TEXT NOT NULL REFERENCES members(id),
  spent_on     INTEGER NOT NULL,
  split_type   TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_household ON expenses(household_id, spent_on DESC);

-- ── 分摊明细 ──────────────────────────────────────────────────────
-- 均摊也把每人实际金额写死在这里，不在查询时重算。
-- 因为 100 元 ÷ 3 人 = 33.33 余 1 分，余数分配规则一旦变化，
-- 重算就会让历史账目跟着漂移。
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id   TEXT NOT NULL REFERENCES expenses(id),
  member_id    TEXT NOT NULL REFERENCES members(id),
  share_amount INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_member ON expense_shares(member_id);

-- ── 实际转账：用于抵消账目 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  from_member  TEXT NOT NULL REFERENCES members(id),
  to_member    TEXT NOT NULL REFERENCES members(id),
  amount       INTEGER NOT NULL,
  settled_on   INTEGER NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_household ON settlements(household_id, settled_on DESC);

-- ── 值日排班 ──────────────────────────────────────────────────────
-- member_ids 是 JSON 数组，记录轮转顺序；next_index 指向当前轮到谁。
CREATE TABLE IF NOT EXISTS chores (
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
CREATE INDEX IF NOT EXISTS idx_chores_household ON chores(household_id, is_active);

CREATE TABLE IF NOT EXISTS chore_logs (
  id         TEXT PRIMARY KEY,
  chore_id   TEXT NOT NULL REFERENCES chores(id),
  member_id  TEXT NOT NULL REFERENCES members(id),
  due_date   INTEGER NOT NULL,
  done_at    INTEGER,
  UNIQUE (chore_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_chore_logs_due ON chore_logs(chore_id, due_date DESC);

-- ── 公告 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  author_id    TEXT NOT NULL REFERENCES members(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_household ON announcements(household_id, is_pinned DESC, created_at DESC);

-- ── 公共物品 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name         TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 0,
  unit         TEXT,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_household ON items(household_id);

-- ── 会话 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
