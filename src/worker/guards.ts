import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { lookupSession, readSessionCookie } from './auth';
import type { SessionRecord } from './auth';
import { errorBody } from '../shared/errors';
import type { AppEnv } from './env';

/** 读 cookie 并查会话。两个中间件共用。 */
async function resolveSession(c: Context<AppEnv>): Promise<SessionRecord | null> {
  const token = readSessionCookie(c.req.header('Cookie'));
  if (!token) return null;
  return lookupSession(c.env.DB, token);
}

const SESSION_EXPIRED_MESSAGE = '登录已过期，请重新登录';

/**
 * 只要求「有一个有效会话」，不要求当前房间里一定有身份。
 * 用在 /api/auth/* 上——那批接口恰恰要处理「已登录但还没选房间」这个中间态。
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json(errorBody('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGE), 401);
  }

  c.set('session', session);
  c.set('accountId', session.accountId);
  await next();
});

/**
 * 认证中间件：校验会话，并确认当前房间下确实有一条在住成员档案，
 * 然后把登录态注入上下文。
 *
 * ⚠️ `memberId` / `householdId` / `memberName` 的**键名和语义刻意保持不变**。
 *    业务路由里 30 多处 `c.get('householdId')` 全靠它们；这次账号体系重构
 *    把「成员身份从哪来」彻底换掉了（以前是 sessions.member_id 直接存着，
 *    现在由 sessions.(account_id, active_household_id) join members 推导），
 *    但对外的上下文形状一模一样，所以那 6 个业务路由文件**一行都不用改**。
 *
 *    如果哪天发现必须去改业务路由才能让新功能工作，那是这里的设计错了，
 *    应该回来改这里，而不是去改业务路由。
 *
 * 成员档案 join 不上时返回 NO_MEMBERSHIP 而不是 401：用户是登录着的，
 * 回登录页解决不了问题（重登也还是同一个状态），前端应该把他导向房间选择页。
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json(errorBody('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGE), 401);
  }

  c.set('session', session);
  c.set('accountId', session.accountId);

  if (!session.activeHouseholdId || !session.memberId || session.memberName === null) {
    return c.json(
      errorBody('NO_MEMBERSHIP', '你还没有加入任何房间，或已从当前房间退租'),
      403,
    );
  }

  c.set('memberId', session.memberId);
  c.set('householdId', session.activeHouseholdId);
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
