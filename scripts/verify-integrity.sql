-- 数据完整性与 schema 核对。迁移之后必跑。
--
--   npm run db:verify:local     # 本地
--   npm run db:verify           # 线上
--
-- 结果是一张张表，**每一行的 bad_rows 都应该是 0**。有非 0 就说明数据或表结构
-- 出了问题，看 check_name 那一列是哪一项。
--
-- 列名刻意用英文：Windows 控制台是 GBK 编码，中文列名会显示成乱码
-- （只是显示问题，数据本身没错，但排查时看着难受）。
--
-- ⚠️ 不要把这些语句合并成一个大的 `UNION ALL`。
--    D1 的 SQLite 构建把复合 SELECT 的项数上限压到了 **5**（不是 SQLite 默认的
--    500）。超了会直接报 `too many terms in compound SELECT`，整份文件一行结果
--    都出不来。这个上限是实测出来的：3、4、5 项通过，6 项就开始报错。
--    所以下面拆成多条语句，每条的 UNION ALL 项数都 ≤ 5；表名和索引名那两组
--    改用 json_each 驱动清单，项数不随检查数量增长。

-- ── 表是否齐全 ────────────────────────────────────────────────────
-- 用 json_each 而不是一串 UNION ALL：想加一张表只要往数组里塞个名字，
-- 不用多一个复合项。而且缺失时 check_name 直接写出是哪张表。

SELECT 'missing table: ' || j.value AS check_name,
       1 - (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = j.value) AS bad_rows
  FROM json_each('["accounts","recovery_codes","households","members","member_pins",
                   "expenses","expense_shares","settlements","chores","chore_logs",
                   "announcements","items","sessions"]') j;

-- ── 关键索引是否齐全 ──────────────────────────────────────────────
-- 这两个索引承担的是**业务正确性**，不只是性能：
--   idx_accounts_email          —— 邮箱唯一性
--   idx_members_account_active  —— 同账号同房间不得有两条在住档案
-- 少了它们不会报错，只会静默地让重复数据写进来。

SELECT 'missing index: ' || j.value AS check_name,
       1 - (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = j.value) AS bad_rows
  FROM json_each('["idx_accounts_email","idx_members_account_active"]') j;

-- ── 表是不是**多**了 ──────────────────────────────────────────────
-- 上面那条只查「少」，查不出「多」。而多出来的表恰恰是重置脚本漏删的症状：
-- 第二期新增 accounts / member_pins / recovery_codes 时 reset-remote-db.sql
-- 没有跟着加，于是重置后这三张表连同里面的测试账号留在库里，而 migrations
-- 再跑到 `CREATE TABLE accounts` 就会撞「表已存在」。核对表清单这一条
-- 是唯一能在重置之后、迁移之前发现它的地方。
--
-- 加表时这里和 reset-remote-db.sql 都要改——这点摩擦是故意的。

-- 恒返回一行（好用 COUNT 表达），所以检查总项数是固定的 27 项，
-- 不会因为「这次恰好没有多出来的表」而少一项。

SELECT 'unexpected table' AS check_name, COUNT(*) AS bad_rows
  FROM sqlite_master
 WHERE type = 'table'
   AND name NOT LIKE 'sqlite_%'
   AND name NOT LIKE '_cf%'
   AND name <> 'd1_migrations'
   AND name NOT IN (SELECT value FROM json_each('["accounts","recovery_codes","households","members","member_pins","expenses","expense_shares","settlements","chores","chore_logs","announcements","items","sessions"]'));

-- ── 悬空引用（第一组）─────────────────────────────────────────────
-- 这些字段没有外键约束（或约束在 D1 上不生效），只能靠这一步发现。
-- 历史账目指向一个不存在的成员时，界面会显示空白名字，账目也再对不平。

SELECT 'orphan expense_shares.member_id' AS check_name, COUNT(*) AS bad_rows FROM expense_shares
  WHERE member_id NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan expenses.paid_by', COUNT(*) FROM expenses
  WHERE paid_by NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan expenses.created_by', COUNT(*) FROM expenses
  WHERE created_by NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan settlements.from_member', COUNT(*) FROM settlements
  WHERE from_member NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan settlements.to_member', COUNT(*) FROM settlements
  WHERE to_member NOT IN (SELECT id FROM members);

-- ── 悬空引用（第二组）─────────────────────────────────────────────

SELECT 'orphan chore_logs.member_id' AS check_name, COUNT(*) AS bad_rows FROM chore_logs
  WHERE member_id NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan announcements.author_id', COUNT(*) FROM announcements
  WHERE author_id NOT IN (SELECT id FROM members)
UNION ALL SELECT 'orphan sessions.account_id', COUNT(*) FROM sessions
  WHERE account_id NOT IN (SELECT id FROM accounts)
UNION ALL SELECT 'orphan members.account_id', COUNT(*) FROM members
  WHERE account_id IS NOT NULL AND account_id NOT IN (SELECT id FROM accounts)
UNION ALL SELECT 'orphan chores.member_ids', COUNT(*) FROM chores
  WHERE EXISTS (
    SELECT 1 FROM json_each(chores.member_ids) j
     WHERE j.value NOT IN (SELECT id FROM members)
  );

-- ⚠️ chores.member_ids 是 JSON 数组，SQLite 建不了外键，SQL 也没法用普通的
--    IN 子查询检查。json_each 是**唯一**能发现里面悬空 id 的办法。
--    这条最容易被漏掉，而它一旦出问题，值日排班会显示成空白名字。

-- ── 业务不变量 ────────────────────────────────────────────────────

-- 同一账号在同一房间出现多条在住档案。分区唯一索引本该挡住这种数据；
-- 真出现了说明索引缺失或被人删过。余额会分裂到两个身份上，而 Σ balance === 0
-- 这个断言**抓不到**——所以这一条必须单独查。
SELECT 'duplicate active membership' AS check_name, COUNT(*) AS bad_rows FROM (
  SELECT account_id, household_id FROM members
   WHERE account_id IS NOT NULL AND is_active = 1
   GROUP BY account_id, household_id HAVING COUNT(*) > 1
)
-- 会话指向一个该账号**完全没有任何关系**的房间。非 0 说明有人手工改过
-- sessions 表（或 /auth/switch 的 EXISTS 守卫有 bug），而 requireAuth 的
-- LEFT JOIN 会把这类请求挡在 403（fail closed），不会泄露数据——
-- 这一条是在确认库里没有这种行。
--
-- ⚠️ 这里刻意**不**要求 `m.is_active = 1`。加了就是错的，而且这个错很隐蔽：
--    `POST /members/:id/leave` 只改 `members.is_active = 0` 和 `move_out`，
--    **不碰** `sessions.active_household_id`。所以「退租了、还没重新加入」
--    这个合法状态长这样：members 行在、is_active = 0、会话仍指向那个房间。
--    加上 is_active = 1 就会把它判成数据损坏——而这是**会长期存在**的状态，
--    不是某个瞬间，所以它会一直红着，直到真正的信号被淹掉。
--
--    实测方法（改这条之前请自己复现一遍）：随便挑一条
--    `active_household_id IS NOT NULL` 的会话，把对应的 members 行改成
--    `is_active = 0`，两种写法分别查一次——带 is_active = 1 的那个报 1，
--    不带的报 0；改回 1 之后两个都回 0。
--
--    真正的篡改是「连 members 行都没有」（账号跟那个房间毫无关系），
--    所以只查 NOT EXISTS 成员行，不看它是否在住。
UNION ALL SELECT 'session without membership', COUNT(*) FROM sessions s
  WHERE s.active_household_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM members m
       WHERE m.account_id = s.account_id
         AND m.household_id = s.active_household_id
    );
