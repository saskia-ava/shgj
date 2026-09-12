import { Hono } from 'hono';
import { computeBalances, suggestTransfers } from '../../shared/balance';
import { newId } from '../ids';
import { findForeignMembers, ownedByHousehold } from '../guards';
import type { AppEnv } from '../env';

const balance = new Hono<AppEnv>();

const MAX_PAGE_SIZE = 200;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ── 余额总览 + 结算建议 ───────────────────────────────────────────

/**
 * 所有人的净余额，以及「最少几笔转账能全部结清」的建议。
 *
 * 实现上用 SQL 聚合而不是把全部流水拉回来算：结果完全一致
 * （computeBalances 只是把金额相加），但传输行数从「历史账目条数」
 * 降到「成员数」，几年账本下来差别很大。
 *
 * 已退租成员（is_active = 0）**必须**一起算——他们参与过的账目仍然影响
 * 其他人的余额，漏掉就会让所有人的余额之和不为 0。
 */
balance.get('/', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;

  const [{ results: memberRows }, { results: paidRows }, { results: shareRows }, { results: settlementRows }] =
    await Promise.all([
      db
        .prepare('SELECT id, name, is_active FROM members WHERE household_id = ? ORDER BY created_at ASC')
        .bind(householdId)
        .all<{ id: string; name: string; is_active: number }>(),
      db
        .prepare(
          'SELECT paid_by AS member_id, SUM(amount) AS total FROM expenses WHERE household_id = ? GROUP BY paid_by',
        )
        .bind(householdId)
        .all<{ member_id: string; total: number }>(),
      db
        .prepare(
          `SELECT es.member_id, SUM(es.share_amount) AS total
             FROM expense_shares es
             JOIN expenses e ON e.id = es.expense_id
            WHERE e.household_id = ?
            GROUP BY es.member_id`,
        )
        .bind(householdId)
        .all<{ member_id: string; total: number }>(),
      db
        .prepare(
          `SELECT from_member, to_member, SUM(amount) AS total
             FROM settlements
            WHERE household_id = ?
            GROUP BY from_member, to_member`,
        )
        .bind(householdId)
        .all<{ from_member: string; to_member: string; total: number }>(),
    ]);

  const memberIds = memberRows.map((m) => m.id);

  const balances = computeBalances(
    memberIds,
    paidRows.map((r) => ({ id: `paid:${r.member_id}`, amount: r.total, paidBy: r.member_id })),
    shareRows.map((r) => ({
      expenseId: `share:${r.member_id}`,
      memberId: r.member_id,
      shareAmount: r.total,
    })),
    settlementRows.map((r) => ({
      fromMember: r.from_member,
      toMember: r.to_member,
      amount: r.total,
    })),
  );

  const transfers = suggestTransfers(balances);
  const nameOf = new Map(memberRows.map((m) => [m.id, m.name]));

  return c.json({
    balances: memberIds.map((id) => ({
      memberId: id,
      name: nameOf.get(id) ?? '未知',
      isActive: memberRows.find((m) => m.id === id)?.is_active === 1,
      amount: balances.get(id) ?? 0,
    })),
    transfers: transfers.map((t) => ({
      from: t.from,
      fromName: nameOf.get(t.from) ?? '未知',
      to: t.to,
      toName: nameOf.get(t.to) ?? '未知',
      amount: t.amount,
    })),
  });
});

// ── 结算记录 ──────────────────────────────────────────────────────

balance.get('/settlements', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), MAX_PAGE_SIZE);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const { results } = await db
    .prepare(
      `SELECT s.id, s.from_member, s.to_member, s.amount, s.settled_on, s.note, s.created_at,
              f.name AS from_name, t.name AS to_name
         FROM settlements s
         JOIN members f ON f.id = s.from_member
         JOIN members t ON t.id = s.to_member
        WHERE s.household_id = ?
        ORDER BY s.settled_on DESC, s.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(householdId, limit, offset)
    .all<{
      id: string;
      from_member: string;
      to_member: string;
      amount: number;
      settled_on: number;
      note: string | null;
      created_at: number;
      from_name: string;
      to_name: string;
    }>();

  const total = await db
    .prepare('SELECT COUNT(*) AS n FROM settlements WHERE household_id = ?')
    .bind(householdId)
    .first<{ n: number }>();

  return c.json({
    total: total?.n ?? 0,
    limit,
    offset,
    settlements: results.map((s) => ({
      id: s.id,
      from: s.from_member,
      fromName: s.from_name,
      to: s.to_member,
      toName: s.to_name,
      amount: s.amount,
      settledOn: s.settled_on,
      note: s.note,
      createdAt: s.created_at,
    })),
  });
});

/** 记录一笔真实发生的转账，用来抵消账目。 */
balance.post('/settlements', async (c) => {
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const from = readString(body.from);
  const to = readString(body.to);
  const amount = body.amount;
  const note = readString(body.note) || null;
  const settledOn =
    typeof body.settledOn === 'number' && Number.isFinite(body.settledOn) ? body.settledOn : Date.now();

  if (!from || !to) return c.json({ error: '请选择付款人和收款人' }, 400);
  if (from === to) return c.json({ error: '付款人和收款人不能是同一个人' }, 400);
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return c.json({ error: '转账金额必须是大于 0 的整数分' }, 400);
  }

  const foreign = await findForeignMembers(db, householdId, [from, to]);
  if (foreign.length > 0) return c.json({ error: '指定的成员不属于当前房间' }, 400);

  const id = newId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO settlements (id, household_id, from_member, to_member, amount, settled_on, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, from, to, amount, settledOn, note, now)
    .run();

  return c.json({ settlement: { id, from, to, amount, settledOn, note, createdBy: memberId } }, 201);
});

/** 删除一笔结算记录（记错了可以撤回）。 */
balance.delete('/settlements/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'settlements', id, householdId))) {
    return c.json({ error: '结算记录不存在' }, 404);
  }

  await db.prepare('DELETE FROM settlements WHERE id = ? AND household_id = ?').bind(id, householdId).run();

  return c.json({ ok: true });
});

export default balance;
