import { createMiddleware } from 'hono/factory';
import { lookupSession, readSessionCookie } from './auth';
import type { AppEnv } from './env';

/**
 * 认证中间件：校验 session cookie，把登录态注入上下文。
 * 挂在除 /api/auth/* 以外的所有路由上。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readSessionCookie(c.req.header('Cookie'));
  if (!token) {
    return c.json({ error: '未登录' }, 401);
  }

  const session = await lookupSession(c.env.DB, token);
  if (!session) {
    return c.json({ error: '登录已过期，请重新登录' }, 401);
  }

  c.set('memberId', session.memberId);
  c.set('householdId', session.householdId);
  c.set('memberName', session.memberName);

  await next();
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 防护第二道防线。
 *
 * 第一道是 session cookie 的 `SameSite=Lax`，它已经能挡住跨站发起的
 * 表单提交。这里再校验一次 Origin：浏览器在跨站写请求上一定会带 Origin，
 * 与本站不符就拒绝。
 *
 * 没有 Origin 头时放行——非浏览器客户端（curl、本地脚本）不会带它，
 * 而它们本来也不受 CSRF 影响。
 */
export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return c.json({ error: '请求来源不合法' }, 403);
    }

    if (originHost !== new URL(c.req.url).host) {
      return c.json({ error: '跨站请求被拒绝' }, 403);
    }
  }

  await next();
});

/** 允许做归属校验的表名白名单。表名会被拼进 SQL，因此必须限定取值。 */
const OWNED_TABLES = [
  'members',
  'expenses',
  'settlements',
  'chores',
  'chore_logs',
  'announcements',
  'items',
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];

/**
 * 确认某行数据属于当前房间。
 *
 * ⚠️ 这是多租户应用最容易被忽略的越权口子：`DELETE /api/expenses/:id`
 * 如果只按 id 删除而不校验归属，任何已登录用户都能删掉别人家的账目。
 * **每一个按 id 操作的端点，都必须先过这一关。**
 *
 * `chore_logs` 没有 household_id 列，调用方需另行校验（见 routes/chores.ts）。
 */
export async function ownedByHousehold(
  db: D1Database,
  table: (typeof OWNED_TABLES)[number],
  id: string,
  householdId: string,
): Promise<boolean> {
  if (!OWNED_TABLES.includes(table)) {
    throw new Error(`不允许的表名：${table}`);
  }

  if (table === 'chore_logs') {
    const row = await db
      .prepare(
        `SELECT 1 AS ok
           FROM chore_logs cl
           JOIN chores c ON c.id = cl.chore_id
          WHERE cl.id = ? AND c.household_id = ?`,
      )
      .bind(id, householdId)
      .first();
    return row !== null;
  }

  const row = await db
    .prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND household_id = ?`)
    .bind(id, householdId)
    .first();
  return row !== null;
}

/**
 * 校验一组成员 id 全部属于当前房间。
 *
 * 分摊明细里的 member_id 有外键指向 members，但 SQLite 的 CHECK 约束
 * 无法跨表校验，所以「成员必须属于同一房间」这条规则只能在应用层守住。
 * 漏掉它就等于给了一个跨房间写脏数据、进而泄露他人账目的口子。
 *
 * 返回不属于本房间的 id 列表，空数组表示全部合法。
 */
export async function findForeignMembers(
  db: D1Database,
  householdId: string,
  memberIds: string[],
): Promise<string[]> {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return [];

  const placeholders = unique.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM members WHERE household_id = ? AND id IN (${placeholders})`)
    .bind(householdId, ...unique)
    .all<{ id: string }>();

  const found = new Set(results.map((r) => r.id));
  return unique.filter((id) => !found.has(id));
}
