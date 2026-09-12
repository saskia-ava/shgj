import { Hono } from 'hono';
import { newId } from '../ids';
import { findForeignMembers, ownedByHousehold } from '../guards';
import type { AppEnv } from '../env';

const chores = new Hono<AppEnv>();

const CYCLES = ['daily', 'weekly', 'monthly'] as const;
type Cycle = (typeof CYCLES)[number];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isCycle(value: string): value is Cycle {
  return CYCLES.includes(value as Cycle);
}

/**
 * 当前周期的起点。
 *
 * 用它作为 chore_logs.due_date，配合 UNIQUE(chore_id, due_date) 保证
 * 「同一周期只生成一条记录」——两个人同时打开页面也不会重复生成。
 * 周起点定为周一（中国习惯），而不是 JS 默认的周日。
 */
export function periodStart(cycle: Cycle, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);

  if (cycle === 'daily') {
    return d.getTime();
  }

  if (cycle === 'weekly') {
    const day = d.getDay(); // 0=周日
    const daysSinceMonday = (day + 6) % 7;
    d.setDate(d.getDate() - daysSinceMonday);
    return d.getTime();
  }

  d.setDate(1);
  return d.getTime();
}

interface ChoreRow {
  id: string;
  name: string;
  cycle: string;
  weekday: number | null;
  member_ids: string;
  next_index: number;
  is_active: number;
  created_at: number;
}

/** 解析轮转成员列表。数据损坏时返回空数组而不是抛错，避免整个页面打不开。 */
function parseMemberIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function currentAssignee(chore: ChoreRow, nameOf: Map<string, string>) {
  const ids = parseMemberIds(chore.member_ids);
  if (ids.length === 0) return null;
  // next_index 越界时取模兜底——成员被删过就容易出现这种情况
  const id = ids[((chore.next_index % ids.length) + ids.length) % ids.length];
  return { id, name: nameOf.get(id) ?? '未知成员' };
}

/** 排班列表，附带当前轮到谁、本周期是否已完成。 */
chores.get('/', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;
  const now = Date.now();

  const [{ results: choreRows }, { results: memberRows }] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, cycle, weekday, member_ids, next_index, is_active, created_at
           FROM chores WHERE household_id = ? ORDER BY is_active DESC, created_at ASC`,
      )
      .bind(householdId)
      .all<ChoreRow>(),
    db
      .prepare('SELECT id, name FROM members WHERE household_id = ?')
      .bind(householdId)
      .all<{ id: string; name: string }>(),
  ]);

  const nameOf = new Map(memberRows.map((m) => [m.id, m.name]));

  // 一次取回所有排班本周期的完成记录，避免逐条查询
  const dueDates = new Map<string, number>();
  for (const chore of choreRows) {
    dueDates.set(chore.id, periodStart(chore.cycle as Cycle, now));
  }

  const doneMap = new Map<string, number | null>();
  if (choreRows.length > 0) {
    const placeholders = choreRows.map(() => '?').join(', ');
    const { results: logs } = await db
      .prepare(
        `SELECT chore_id, due_date, done_at FROM chore_logs
          WHERE chore_id IN (${placeholders})`,
      )
      .bind(...choreRows.map((r) => r.id))
      .all<{ chore_id: string; due_date: number; done_at: number | null }>();

    for (const log of logs) {
      if (dueDates.get(log.chore_id) === log.due_date) {
        doneMap.set(log.chore_id, log.done_at);
      }
    }
  }

  return c.json({
    chores: choreRows.map((chore) => {
      const assignee = currentAssignee(chore, nameOf);
      return {
        id: chore.id,
        name: chore.name,
        cycle: chore.cycle,
        weekday: chore.weekday,
        memberIds: parseMemberIds(chore.member_ids),
        isActive: chore.is_active === 1,
        currentAssignee: assignee,
        periodStart: dueDates.get(chore.id) ?? null,
        doneAt: doneMap.get(chore.id) ?? null,
      };
    }),
  });
});

chores.post('/', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const name = readString(body.name);
  const cycle = readString(body.cycle) || 'weekly';
  const weekday = typeof body.weekday === 'number' ? body.weekday : null;
  const rawMemberIds = body.memberIds;

  if (!name) return c.json({ error: '请填写值日项目名称' }, 400);
  if (name.length > 30) return c.json({ error: '名称最多 30 个字' }, 400);
  if (!isCycle(cycle)) return c.json({ error: `周期只能是：${CYCLES.join('、')}` }, 400);
  if (cycle === 'weekly' && weekday !== null && (weekday < 0 || weekday > 6)) {
    return c.json({ error: '星期取值必须在 0~6 之间' }, 400);
  }
  if (!Array.isArray(rawMemberIds) || rawMemberIds.length === 0) {
    return c.json({ error: '请选择轮转成员' }, 400);
  }

  const memberIds = [...new Set(rawMemberIds.filter((x): x is string => typeof x === 'string'))];
  if (memberIds.length === 0) return c.json({ error: '请选择轮转成员' }, 400);

  const foreign = await findForeignMembers(db, householdId, memberIds);
  if (foreign.length > 0) return c.json({ error: '指定的成员不属于当前房间' }, 400);

  const id = newId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO chores (id, household_id, name, cycle, weekday, member_ids, next_index, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
    )
    .bind(id, householdId, name, cycle, weekday, JSON.stringify(memberIds), now)
    .run();

  return c.json({ chore: { id, name, cycle, weekday, memberIds, isActive: true } }, 201);
});

chores.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'chores', id, householdId))) {
    return c.json({ error: '排班不存在' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const fields: string[] = [];
  const values: unknown[] = [];

  if ('name' in body) {
    const name = readString(body.name);
    if (!name) return c.json({ error: '名称不能为空' }, 400);
    if (name.length > 30) return c.json({ error: '名称最多 30 个字' }, 400);
    fields.push('name = ?');
    values.push(name);
  }
  if ('cycle' in body) {
    const cycle = readString(body.cycle);
    if (!isCycle(cycle)) return c.json({ error: `周期只能是：${CYCLES.join('、')}` }, 400);
    fields.push('cycle = ?');
    values.push(cycle);
  }
  if ('weekday' in body) {
    const weekday = typeof body.weekday === 'number' ? body.weekday : null;
    if (weekday !== null && (weekday < 0 || weekday > 6)) {
      return c.json({ error: '星期取值必须在 0~6 之间' }, 400);
    }
    fields.push('weekday = ?');
    values.push(weekday);
  }
  if ('isActive' in body) {
    fields.push('is_active = ?');
    values.push(body.isActive ? 1 : 0);
  }
  if ('memberIds' in body) {
    const raw = body.memberIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      return c.json({ error: '请选择轮转成员' }, 400);
    }
    const memberIds = [...new Set(raw.filter((x): x is string => typeof x === 'string'))];
    if (memberIds.length === 0) return c.json({ error: '请选择轮转成员' }, 400);

    const foreign = await findForeignMembers(db, householdId, memberIds);
    if (foreign.length > 0) return c.json({ error: '指定的成员不属于当前房间' }, 400);

    fields.push('member_ids = ?', 'next_index = 0'); // 成员变了就重头轮转
    values.push(JSON.stringify(memberIds));
  }

  if (fields.length === 0) return c.json({ error: '没有需要更新的字段' }, 400);

  values.push(id, householdId);
  await db
    .prepare(`UPDATE chores SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

chores.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'chores', id, householdId))) {
    return c.json({ error: '排班不存在' }, 404);
  }

  await db.batch([
    db.prepare('DELETE FROM chore_logs WHERE chore_id = ?').bind(id),
    db.prepare('DELETE FROM chores WHERE id = ? AND household_id = ?').bind(id, householdId),
  ]);

  return c.json({ ok: true });
});

/**
 * 标记本周期已完成，并把轮转推进到下一个人。
 *
 * 先写 chore_logs 再推进 next_index，两步在同一事务里。
 * 顺序反了的话，一旦中途失败就会出现「人轮过去了、但记录没留下」，
 * 而因为这个周期已经有 log，重试也不会再补上。
 */
chores.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;
  const now = Date.now();

  const chore = await db
    .prepare(
      `SELECT id, cycle, member_ids, next_index FROM chores
        WHERE id = ? AND household_id = ? AND is_active = 1`,
    )
    .bind(id, householdId)
    .first<{ id: string; cycle: string; member_ids: string; next_index: number }>();

  if (!chore) return c.json({ error: '排班不存在或已暂停' }, 404);

  const memberIds = parseMemberIds(chore.member_ids);
  if (memberIds.length === 0) return c.json({ error: '这个排班没有轮转成员' }, 400);

  const assigneeId = memberIds[((chore.next_index % memberIds.length) + memberIds.length) % memberIds.length];
  const due = periodStart(chore.cycle as Cycle, now);

  const existing = await db
    .prepare('SELECT id, done_at FROM chore_logs WHERE chore_id = ? AND due_date = ?')
    .bind(id, due)
    .first<{ id: string; done_at: number | null }>();

  if (existing?.done_at) {
    return c.json({ error: '这个周期已经标记完成了' }, 409);
  }

  const nextIndex = (chore.next_index + 1) % memberIds.length;

  await db.batch([
    existing
      ? db.prepare('UPDATE chore_logs SET done_at = ? WHERE id = ?').bind(now, existing.id)
      : db
          .prepare(
            'INSERT INTO chore_logs (id, chore_id, member_id, due_date, done_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(newId(), id, assigneeId, due, now),
    db.prepare('UPDATE chores SET next_index = ? WHERE id = ?').bind(nextIndex, id),
  ]);

  return c.json({ ok: true, completedBy: assigneeId, nextAssigneeId: memberIds[nextIndex] });
});

/** 完成历史。 */
chores.get('/logs', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const choreId = c.req.query('choreId');

  const where = ['ch.household_id = ?', 'cl.done_at IS NOT NULL'];
  const params: unknown[] = [householdId];
  if (choreId) {
    where.push('cl.chore_id = ?');
    params.push(choreId);
  }

  const { results } = await db
    .prepare(
      `SELECT cl.id, cl.chore_id, cl.due_date, cl.done_at, ch.name AS chore_name, m.name AS member_name
         FROM chore_logs cl
         JOIN chores ch ON ch.id = cl.chore_id
         JOIN members m ON m.id = cl.member_id
        WHERE ${where.join(' AND ')}
        ORDER BY cl.done_at DESC
        LIMIT ?`,
    )
    .bind(...params, limit)
    .all<{
      id: string;
      chore_id: string;
      due_date: number;
      done_at: number;
      chore_name: string;
      member_name: string;
    }>();

  return c.json({
    logs: results.map((l) => ({
      id: l.id,
      choreId: l.chore_id,
      choreName: l.chore_name,
      memberName: l.member_name,
      dueDate: l.due_date,
      doneAt: l.done_at,
    })),
  });
});

export default chores;
