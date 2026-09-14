-- ⚠️⚠️ 清空线上数据库。会删掉全部业务数据，不可撤销。⚠️⚠️
--
-- 只在「schema 大改、决定不写数据迁移」时手工执行一次，执行前必须先导出备份：
--
--   npx wrangler d1 export hezu-db --remote --output=backup-before-rebuild.sql
--   npx wrangler d1 execute hezu-db --remote --file=./scripts/reset-remote-db.sql
--   npm run db:remote
--   npm run db:verify
--
-- ⚠️ 这个文件**绝不能**放进 migrations/ 目录。
--    放进去的话，任何人重置 d1_migrations 后跑 `migrations apply`，
--    它会真的执行并清空生产库——而且看起来就像一次正常的迁移。
--
-- 顺序：先子表后父表。SQLite 默认不强制外键，顺序其实不影响结果，
-- 但保持这个顺序是为了让这个文件本身读起来是对的。
--
-- ⚠️ **加了新表就要回来加一行。** 漏掉一张表的后果不是「留下点垃圾数据」——
--    它是 `migrations apply` 在 `CREATE TABLE` 上撞「表已存在」然后整批失败，
--    而此时前几张表已经建好了，库处于一个迁移没跑完的中间态。
--    这个文件是第一期写的，第二期加的 accounts / member_pins / recovery_codes
--    就漏过一次，是靠 `SELECT name FROM sqlite_master` 逐张数出来的。
--    改完请对一遍：线上业务表应当正好是 13 张（verify-integrity.sql 里有清单）。
--
-- 不删 _cf_KV：那是 Cloudflare 自己的内部表。

DROP TABLE IF EXISTS expense_shares;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS settlements;
DROP TABLE IF EXISTS chore_logs;
DROP TABLE IF EXISTS chores;
DROP TABLE IF EXISTS announcements;
DROP TABLE IF EXISTS items;
-- 下面三张是第二期（账号体系）新增的，删的次序要在它们引用的表之前
DROP TABLE IF EXISTS recovery_codes;
DROP TABLE IF EXISTS member_pins;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS households;

-- ⚠️ d1_migrations 必须一起删。
--    不删的话 `migrations apply` 会输出「✅ No more migrations to apply」
--    然后给你留下一张**空库**——这个失败模式看起来完全像成功。
--    本项目第一次重建时这张表还不存在（之前是用 schema.sql 直接建表的），
--    但以后重建就会踩到，所以无论如何都写上。
DROP TABLE IF EXISTS d1_migrations;
