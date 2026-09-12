import { Hono } from 'hono';
import { splitEqually } from '../../shared/money';
import { newId } from '../ids';
import { findForeignMembers, ownedByHousehold } from '../guards';
import type { AppEnv } from '../env';

const expenses = new Hono<AppEnv>();

const CATEGORIES = ['房租', '水电', '燃气', '网费', '日用', '维修', '其他'] as const;

/** 单页条数上限，防止有人用 ?limit=999999 拖垮查询。 */
const MAX_PAGE_SIZE = 200;

interface ShareInput {
  memberId: string;
  shareAmount: number;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 金额必须是非零整数分。零元账目没有意义，负数走「退款」语义另行处理。 */
function isPositiveIntCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 解析分摊方案。
 *
 * 均摊一律由服务端用 splitEqually 重算，不采信客户端传来的金额——
 * 客户端算错（或被人改过）就会写出对不平的账目，而这类脏数据极难排查。
 */
function resolveShares(
  splitType: string,
  amount: number,
  rawShares: unknown,
  rawMemberIds: unknown,
): { ok: true; shares: ShareInput[] } | { ok: false; error: string } {
  if (splitType === 'equal') {
    if (!Array.isArray(rawMemberIds) || rawMemberIds.length === 0) {
      return { ok: false, error: '请选择参与分摊的成员' };
    }
    const memberIds = [...new Set(rawMemberIds.filter((x): x is string => typeof x === 'string'))];
    if (memberIds.length === 0) {
      return { ok: false, error: '请选择参与分摊的成员' };
    }
    return {
      ok: true,
      shares: [...splitEqually(amount, memberIds)].map(([memberId, shareAmount]) => ({
        memberId,
        shareAmount,
      })),
    };
  }

  if (splitType === 'custom') {
    if (!Array.isArray(rawShares) || rawShares.length === 0) {
      return { ok: false, error: '请填写每个人的分摊金额' };
    }

    const parsed: ShareInput[] = [];
    for (const item of rawShares) {
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: '分摊数据格式不正确' };
      }
      const { memberId, shareAmount } = item as Record<string, unknown>;
      if (typeof memberId !== 'string' || !memberId) {
        return { ok: false, error: '分摊数据缺少成员' };
      }
      if (typeof shareAmount !== 'number' || !Number.isInteger(shareAmount) || shareAmount < 0) {
        return { ok: false, error: '分摊金额必须是非负整数分' };
      }
      parsed.push({ memberId, shareAmount });
    }

    // 同一成员不能出现两次，否则余额会重复扣减
    if (new Set(parsed.map((s) => s.memberId)).size !== parsed.length) {
      return { ok: false, error: '同一成员不能重复分摊' };
    }

    const total = parsed.reduce((sum, s) => sum + s.shareAmount, 0);
    if (total !== amount) {
      return { ok: false, error: `分摊金额之和必须等于账目总额（相差 ${total - amount} 分）` };
    }

    return { ok: true, shares: parsed };
  }

  return { ok: false, error: '分摊方式只能是 equal 或 custom' };
}

// ── 列表 ──────────────────────────────────────────────────────────

expenses.get('/', async (c) => {
  const householdId = c.get('householdId');
  const db = c.env.DB;

  const limit = Math.min(
    Math.max(Number(c.req.query('limit')) || 50, 1),
    MAX_PAGE_SIZE,
  );
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const category = c.req.query('category');

  const where = ['e.household_id = ?'];
  const params: unknown[] = [householdId];
  if (category) {
    where.push('e.category = ?');
    params.push(category);
  }

  const { results: rows } = await db
    .prepare(
      `SELECT e.id, e.title, e.amount, e.category, e.paid_by, e.spent_on,
              e.split_type, e.note, e.created_at, m.name AS paid_by_name
         FROM expenses e
         JOIN members m ON m.id = e.paid_by
        WHERE ${where.join(' AND ')}
        ORDER BY e.spent_on DESC, e.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<{
      id: string;
      title: string;
      amount: number;
      category: string;
      paid_by: string;
      paid_by_name: string;
      spent_on: number;
      split_type: string;
      note: string | null;
      created_at: number;
    }>();

  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM expenses e WHERE ${where.join(' AND ')}`)
    .bind(...params)
    .first<{ n: number }>();

  // 一次取回本页所有账目的分摊明细，避免 N+1 查询
  const sharesByExpense = new Map<string, { memberId: string; shareAmount: number }[]>();
  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ');
    const { results: shareRows } = await db
      .prepare(
        `SELECT expense_id, member_id, share_amount
           FROM expense_shares
          WHERE expense_id IN (${placeholders})`,
      )
      .bind(...rows.map((r) => r.id))
      .all<{ expense_id: string; member_id: string; share_amount: number }>();

    for (const s of shareRows) {
      const list = sharesByExpense.get(s.expense_id) ?? [];
      list.push({ memberId: s.member_id, shareAmount: s.share_amount });
      sharesByExpense.set(s.expense_id, list);
    }
  }

  return c.json({
    total: total?.n ?? 0,
    limit,
    offset,
    expenses: rows.map((e) => ({
      id: e.id,
      title: e.title,
      amount: e.amount,
      category: e.category,
      paidBy: e.paid_by,
      paidByName: e.paid_by_name,
      spentOn: e.spent_on,
      splitType: e.split_type,
      note: e.note,
      createdAt: e.created_at,
      shares: sharesByExpense.get(e.id) ?? [],
    })),
  });
});

// ── 新建 ──────────────────────────────────────────────────────────

expenses.post('/', async (c) => {
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const title = readString(body.title);
  const amount = body.amount;
  const category = readString(body.category) || '其他';
  const paidBy = readString(body.paidBy);
  const splitType = readString(body.splitType) || 'equal';
  const note = readString(body.note) || null;
  const spentOn =
    typeof body.spentOn === 'number' && Number.isFinite(body.spentOn) ? body.spentOn : Date.now();

  if (!title) return c.json({ error: '请填写账目名称' }, 400);
  if (title.length > 50) return c.json({ error: '账目名称最多 50 个字' }, 400);
  if (!isPositiveIntCents(amount)) {
    return c.json({ error: '金额必须是大于 0 的整数分' }, 400);
  }
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return c.json({ error: `分类只能是：${CATEGORIES.join('、')}` }, 400);
  }
  if (!paidBy) return c.json({ error: '请选择谁付的钱' }, 400);

  const resolved = resolveShares(splitType, amount, body.shares, body.memberIds);
  if (!resolved.ok) return c.json({ error: resolved.error }, 400);

  // ★ 跨房间校验：分摊明细的外键只保证成员存在，不保证属于本房间。
  //   漏掉这一步就能把账目分摊给别的房间的成员，造成跨租户数据污染。
  const foreign = await findForeignMembers(db, householdId, [
    paidBy,
    ...resolved.shares.map((s) => s.memberId),
  ]);
  if (foreign.length > 0) {
    return c.json({ error: '指定的成员不属于当前房间' }, 400);
  }

  const id = newId();
  const now = Date.now();

  // batch 是单个事务：账目与分摊明细要么一起写入，要么都不写。
  // 中途失败留下「有账目无分摊」的记录会让余额永久对不平。
  await db.batch([
    db
      .prepare(
        `INSERT INTO expenses
           (id, household_id, title, amount, category, paid_by, spent_on, split_type, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, householdId, title, amount, category, paidBy, spentOn, splitType, note, memberId, now),
    ...resolved.shares.map((s) =>
      db
        .prepare('INSERT INTO expense_shares (expense_id, member_id, share_amount) VALUES (?, ?, ?)')
        .bind(id, s.memberId, s.shareAmount),
    ),
  ]);

  return c.json({ expense: { id, title, amount, category, paidBy, spentOn, splitType, note, shares: resolved.shares } }, 201);
});

// ── 修改 ──────────────────────────────────────────────────────────

expenses.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'expenses', id, householdId))) {
    return c.json({ error: '账目不存在' }, 404);
  }

  const current = await db
    .prepare('SELECT amount, split_type FROM expenses WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .first<{ amount: number; split_type: string }>();

  if (!current) return c.json({ error: '账目不存在' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const fields: string[] = [];
  const values: unknown[] = [];

  if ('title' in body) {
    const title = readString(body.title);
    if (!title) return c.json({ error: '账目名称不能为空' }, 400);
    if (title.length > 50) return c.json({ error: '账目名称最多 50 个字' }, 400);
    fields.push('title = ?');
    values.push(title);
  }
  if ('category' in body) {
    const category = readString(body.category);
    if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
      return c.json({ error: `分类只能是：${CATEGORIES.join('、')}` }, 400);
    }
    fields.push('category = ?');
    values.push(category);
  }
  if ('note' in body) {
    fields.push('note = ?');
    values.push(readString(body.note) || null);
  }
  if ('spentOn' in body && typeof body.spentOn === 'number') {
    fields.push('spent_on = ?');
    values.push(body.spentOn);
  }
  if ('paidBy' in body) {
    const paidBy = readString(body.paidBy);
    if (!paidBy) return c.json({ error: '付款人不能为空' }, 400);
    const foreign = await findForeignMembers(db, householdId, [paidBy]);
    if (foreign.length > 0) return c.json({ error: '指定的成员不属于当前房间' }, 400);
    fields.push('paid_by = ?');
    values.push(paidBy);
  }

  // 金额或分摊方式一旦变动，分摊明细必须整体重算，否则总额对不上。
  const amountChanged = 'amount' in body;
  const splitChanged = 'shares' in body || 'memberIds' in body || 'splitType' in body;

  if (amountChanged || splitChanged) {
    const amount = amountChanged ? body.amount : current.amount;
    if (!isPositiveIntCents(amount)) {
      return c.json({ error: '金额必须是大于 0 的整数分' }, 400);
    }
    const splitType = 'splitType' in body ? readString(body.splitType) : current.split_type;

    let rawShares = body.shares;
    let rawMemberIds = body.memberIds;

    // 只改金额、没传分摊方式时，沿用原方案：均摊的按新总额重分，
    // 自定义的按原比例缩放会有余数问题，因此要求客户端明确重传。
    if (!splitChanged) {
      if (splitType === 'custom') {
        return c.json({ error: '修改金额时请一并提供新的分摊明细' }, 400);
      }
      const existing = await db
        .prepare('SELECT member_id FROM expense_shares WHERE expense_id = ?')
        .bind(id)
        .all<{ member_id: string }>();
      rawMemberIds = existing.results.map((r) => r.member_id);
    }

    const resolved = resolveShares(splitType, amount, rawShares, rawMemberIds);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);

    const foreign = await findForeignMembers(db, householdId, resolved.shares.map((s) => s.memberId));
    if (foreign.length > 0) return c.json({ error: '指定的成员不属于当前房间' }, 400);

    fields.push('amount = ?', 'split_type = ?');
    values.push(amount, splitType);

    values.push(id, householdId);
    await db.batch([
      db.prepare(`UPDATE expenses SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`).bind(...values),
      db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').bind(id),
      ...resolved.shares.map((s) =>
        db
          .prepare('INSERT INTO expense_shares (expense_id, member_id, share_amount) VALUES (?, ?, ?)')
          .bind(id, s.memberId, s.shareAmount),
      ),
    ]);

    return c.json({ ok: true });
  }

  if (fields.length === 0) return c.json({ error: '没有需要更新的字段' }, 400);

  values.push(id, householdId);
  await db
    .prepare(`UPDATE expenses SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

// ── 删除 ──────────────────────────────────────────────────────────

expenses.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'expenses', id, householdId))) {
    return c.json({ error: '账目不存在' }, 404);
  }

  // 先删分摊明细再删账目，同一事务内完成。
  // 留下孤儿分摊记录会让余额永远对不平。
  await db.batch([
    db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').bind(id),
    db.prepare('DELETE FROM expenses WHERE id = ? AND household_id = ?').bind(id, householdId),
  ]);

  return c.json({ ok: true });
});

export default expenses;
