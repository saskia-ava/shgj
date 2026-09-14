import { Hono } from 'hono';
import { newId } from '../ids';
import { ownedByHousehold } from '../guards';
import { isValidAvatar } from '../../shared/avatars';
import type { AppEnv } from '../env';

const members = new Hono<AppEnv>();

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 列表默认包含已退租成员——历史账目要能显示出他们的名字。
 *
 * ⚠️ `has_pin` 必须走 **LEFT JOIN member_pins**，不能写成裸的
 *    `(pin_hash IS NOT NULL)`。
 *
 *    第二期把 PIN 从 members 挪到了 member_pins，但这条 SELECT 里的
 *    `pin_hash` 没跟着改——而 members 上已经没有这一列了。于是这条 SQL
 *    在 D1 上直接报 `no such column: pin_hash`，整个 `GET /members` **500**。
 *
 *    这个 bug 从第二期重建（9699a7d）一直活到 2026-09-14 才被发现，原因是
 *    **没有任何测试覆盖过 GET /members**：E2E 全程用 /auth/me、/balance、
 *    /expenses，从没调过它；而前端 `reloadMembers()` 是个 `void` 掉的
 *    promise，500 只会让成员列表静默变空、名字显示成「未知成员」，
 *    不会白屏也不会报错。所以它看起来「只是有点怪」，而不是「坏了」。
 *
 *    教训见 scripts/e2e-phase2.mjs 第 12 节：给这个端点补了断言。
 */
members.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.id, m.name, m.room, m.phone, m.avatar,
              m.move_in, m.move_out, m.is_active,
              (m.account_id IS NOT NULL) AS has_account,
              (p.pin_hash IS NOT NULL) AS has_pin
         FROM members m
         LEFT JOIN member_pins p ON p.member_id = m.id
        WHERE m.household_id = ?
        ORDER BY m.is_active DESC, m.created_at ASC`,
    )
    .bind(c.get('householdId'))
    .all<{
      id: string;
      name: string;
      room: string | null;
      phone: string | null;
      avatar: string | null;
      move_in: number | null;
      move_out: number | null;
      is_active: number;
      has_account: number;
      has_pin: number;
    }>();

  return c.json({
    members: results.map((m) => ({
      id: m.id,
      name: m.name,
      room: m.room,
      phone: m.phone,
      avatar: m.avatar,
      moveIn: m.move_in,
      moveOut: m.move_out,
      isActive: m.is_active === 1,
      // 「有没有被账号认领」。前端靠它决定退租 / 恢复按钮画不画：
      // 有账号的只有本人能动，占位档案谁都能动（见 canManage 的注释）。
      hasAccount: m.has_account === 1,
      hasPin: m.has_pin === 1,
    })),
  });
});

/**
 * 添加成员（占位）。
 *
 * 不设 PIN——被添加的人之后用邀请码 + 同样的名字加入，会自动认领这条记录
 * 并设置自己的 PIN（见 routes/auth.ts 的 /join）。
 */
members.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const name = readString(body.name);
  const room = readString(body.room) || null;
  const phone = readString(body.phone) || null;

  if (!name) return c.json({ error: '请填写名字' }, 400);
  if (name.length > 20) return c.json({ error: '名字最多 20 个字' }, 400);

  const db = c.env.DB;
  const householdId = c.get('householdId');

  const duplicate = await db
    .prepare('SELECT id FROM members WHERE household_id = ? AND name = ? AND is_active = 1')
    .bind(householdId, name)
    .first();

  if (duplicate) return c.json({ error: '已经有同名的在住成员了' }, 409);

  const id = newId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO members (id, household_id, name, room, phone, move_in, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, householdId, name, room, phone, now, now)
    .run();

  // ⚠️ 返回体的形状要和 GET /members 里那一条**对齐**（含 avatar、hasAccount）。
  //    只差一个字段的话，前端哪天改成直接用这个返回值（现在没用）就会
  //    拿到一个 avatar 是 undefined 的成员，渲染成首字母而不是他设的头像——
  //    而且只在「刚添加完那一次渲染」出错，看上去像随机 bug。
  //
  //    `hasAccount: false` 不是写死的巧合：这个端点建出来的**就是**占位档案，
  //    认领只能靠对方用邀请码加入（routes/auth.ts 的 /join）。
  return c.json(
    { member: { id, name, room, phone, avatar: null, isActive: true, hasAccount: false, hasPin: false } },
    201,
  );
});

/** 修改成员资料。 */
members.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');

  if (!(await ownedByHousehold(c.env.DB, 'members', id, householdId))) {
    return c.json({ error: '成员不存在' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const fields: string[] = [];
  const values: unknown[] = [];

  if ('name' in body) {
    const name = readString(body.name);
    if (!name) return c.json({ error: '名字不能为空' }, 400);
    if (name.length > 20) return c.json({ error: '名字最多 20 个字' }, 400);
    fields.push('name = ?');
    values.push(name);
  }
  if ('room' in body) {
    fields.push('room = ?');
    values.push(readString(body.room) || null);
  }
  if ('phone' in body) {
    fields.push('phone = ?');
    values.push(readString(body.phone) || null);
  }
  if ('avatar' in body) {
    // ⚠️ 头像这一项比其他字段严：**只能改自己的**。
    //
    //    这个路由整体是「房间成员可以编辑本房间的成员资料」，名字和房间
    //    确实有「帮室友维护资料」的正当场景（人还没进来，先替他建好）。
    //    但头像不一样——它的主张就是「这是我」，替别人挑头像没有任何
    //    合理场景，只有「给室友挂个丑头像」这一种用法。
    //
    //    null 是合法值，表示清空、回到首字母兜底；非法值才报错，
    //    两者分开，别让「清空」被当成「传了坏数据」。
    const raw = body.avatar;
    if (raw !== null && !isValidAvatar(raw)) {
      return c.json({ error: '头像不在可选范围内' }, 400);
    }
    if (id !== c.get('memberId')) {
      return c.json({ error: '只能换自己的头像' }, 403);
    }
    fields.push('avatar = ?');
    values.push(raw);
  }

  if (fields.length === 0) return c.json({ error: '没有需要更新的字段' }, 400);

  values.push(id, householdId);
  await c.env.DB.prepare(
    `UPDATE members SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`,
  )
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

/**
 * 取成员并确认它属于当前房间，顺带带回 `account_id`。
 *
 * 没有复用 `ownedByHousehold`：那个只回 `1 AS ok`，而这里还要判断这条
 * 档案**有没有被认领**（`account_id` 是否为空）才能定权限。一次查询把
 * 归属和认领状态一起取回来，D1 往返次数和原来一样（这套架构里 CPU 大头
 * 在 D1，能不加就不加）。
 */
async function findMember(
  db: D1Database,
  id: string,
  householdId: string,
): Promise<{ accountId: string | null } | null> {
  return db
    .prepare('SELECT account_id AS accountId FROM members WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .first<{ accountId: string | null }>();
}

/**
 * 退租 / 恢复的权限规则——**只有自己能操作自己的身份**，外加一条占位例外。
 *
 * 为什么要管这件事：这两个端点原来只校验「这条档案属于本房间」，
 * 也就是**谁都能退谁、谁都能恢复谁**。其中 `restore` 更重——它会把
 * `is_active` 翻回 1，而中间件正是按 `m.is_active = 1` join 出成员身份的，
 * 所以恢复一个人等于**把他的账号重新放进这个房间**，能看全部账目。
 * 那不是「标记错了可以撤回」，那是单向的授权操作。
 *
 * ⚠️ **占位档案（`account_id IS NULL`）必须例外，否则会造出一个死胡同。**
 *    占位档案是「先替还没进来的人建好名字」用的，它根本没有账号，
 *    **永远没法退自己**。一律锁成「只能退自己」的话，一个最终没搬进来
 *    的占位档案就永久卡在「在住」名单里——没有删除端点，只有退租。
 *    所以规则是「有账号的只能自己动，没账号的谁都能动」。
 */
function canManage(target: { accountId: string | null }, memberId: string, id: string): boolean {
  return id === memberId || target.accountId === null;
}

/**
 * 标记退租（软删除）。
 *
 * 不删行：他参与过的历史账目、分摊明细必须还能显示出名字，
 * 硬删除会让账目变成孤儿数据、余额对不平。
 */
members.post('/:id/leave', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const target = await findMember(db, id, householdId);
  if (!target) {
    return c.json({ error: '成员不存在' }, 404);
  }
  if (!canManage(target, memberId, id)) {
    return c.json({ error: '只能退租自己的身份' }, 403);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const raw = body.moveOut;
  const moveOut = typeof raw === 'number' && Number.isFinite(raw) ? raw : Date.now();

  await db
    .prepare('UPDATE members SET is_active = 0, move_out = ? WHERE id = ? AND household_id = ?')
    .bind(moveOut, id, householdId)
    .run();

  return c.json({ ok: true });
});

/**
 * 恢复在住状态（退租标记错了可以撤回）。
 *
 * 权限和 `leave` 完全一致，别以为这里可以松：它才是授予访问权的那一头。
 */
members.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const target = await findMember(db, id, householdId);
  if (!target) {
    return c.json({ error: '成员不存在' }, 404);
  }
  if (!canManage(target, memberId, id)) {
    return c.json({ error: '只能恢复自己的身份' }, 403);
  }

  await db
    .prepare('UPDATE members SET is_active = 1, move_out = NULL WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .run();

  return c.json({ ok: true });
});

// PIN 的设置/修改已迁到 POST /api/auth/pin。
//
// 原来这里是 POST /api/members/:id/pin，有两个问题：
//   1. 成员 id 出现在 URL 里，等于把一个越权面直接开在路径上（虽然靠
//      `id !== memberId` 挡住了，但每多一个按 id 操作的端点就多一份风险）
//   2. 一个请求跑两次 PBKDF2（验旧 PIN + 算新 PIN），贴着 Workers
//      免费版 10ms CPU 上限，而这条路径从来没被实测过
//
// 新端点作用在「当前会话所在房间里的自己」身上，从根上没有 id 可传。

export default members;
