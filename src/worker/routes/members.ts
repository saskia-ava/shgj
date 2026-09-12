import { Hono } from 'hono';
import {
  clearFailedAttempts,
  hashPin,
  validatePin,
  verifyPin,
} from '../auth';
import { newId } from '../ids';
import { ownedByHousehold } from '../guards';
import type { AppEnv } from '../env';

const members = new Hono<AppEnv>();

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 列表默认包含已退租成员——历史账目要能显示出他们的名字。 */
members.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, room, phone, move_in, move_out, is_active,
              (pin_hash IS NOT NULL) AS has_pin
         FROM members
        WHERE household_id = ?
        ORDER BY is_active DESC, created_at ASC`,
    )
    .bind(c.get('householdId'))
    .all<{
      id: string;
      name: string;
      room: string | null;
      phone: string | null;
      move_in: number | null;
      move_out: number | null;
      is_active: number;
      has_pin: number;
    }>();

  return c.json({
    members: results.map((m) => ({
      id: m.id,
      name: m.name,
      room: m.room,
      phone: m.phone,
      moveIn: m.move_in,
      moveOut: m.move_out,
      isActive: m.is_active === 1,
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

  return c.json({ member: { id, name, room, phone, isActive: true, hasPin: false } }, 201);
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
 * 标记退租（软删除）。
 *
 * 不删行：他参与过的历史账目、分摊明细必须还能显示出名字，
 * 硬删除会让账目变成孤儿数据、余额对不平。
 */
members.post('/:id/leave', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'members', id, householdId))) {
    return c.json({ error: '成员不存在' }, 404);
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

/** 恢复在住状态（退租标记错了可以撤回）。 */
members.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'members', id, householdId))) {
    return c.json({ error: '成员不存在' }, 404);
  }

  await db
    .prepare('UPDATE members SET is_active = 1, move_out = NULL WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .run();

  return c.json({ ok: true });
});

/**
 * 修改自己的 PIN。
 *
 * 已设置过 PIN 的，必须先提供旧 PIN。
 *
 * ⚠️ 有意不提供「重置他人 PIN」的能力：那会变成一条绕过登录限速的旁路——
 * 拿到邀请码的人只要重置目标的 PIN 就能直接冒充他，而登录接口上那套
 * 失败锁定完全不起作用。代价是忘记 PIN 后无法自助找回，这是已知取舍。
 */
members.post('/:id/pin', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');

  if (id !== c.get('memberId')) {
    return c.json({ error: '只能修改自己的 PIN' }, 403);
  }

  const pepper = c.env.PIN_PEPPER;
  if (!pepper || pepper.length < 16) {
    return c.json({ error: '服务端未配置 PIN_PEPPER 密钥' }, 500);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const newPin = body.newPin;
  const oldPin = typeof body.oldPin === 'string' ? body.oldPin : '';

  const pinError = validatePin(newPin);
  if (pinError) return c.json({ error: pinError }, 400);

  const db = c.env.DB;
  const member = await db
    .prepare('SELECT pin_hash FROM members WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .first<{ pin_hash: string | null }>();

  if (!member) return c.json({ error: '成员不存在' }, 404);

  if (member.pin_hash) {
    if (!oldPin) return c.json({ error: '请输入当前 PIN' }, 400);
    if (!(await verifyPin(oldPin, member.pin_hash, pepper))) {
      await db
        .prepare('UPDATE members SET failed_tries = failed_tries + 1 WHERE id = ?')
        .bind(id)
        .run();
      return c.json({ error: '当前 PIN 不正确' }, 401);
    }
  }

  const pinHash = await hashPin(newPin as string, pepper);
  await db.prepare('UPDATE members SET pin_hash = ? WHERE id = ?').bind(pinHash, id).run();
  await clearFailedAttempts(db, id);

  return c.json({ ok: true });
});

export default members;
