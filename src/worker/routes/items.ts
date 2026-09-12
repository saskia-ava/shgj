import { Hono } from 'hono';
import { newId } from '../ids';
import { ownedByHousehold } from '../guards';
import type { AppEnv } from '../env';

const items = new Hono<AppEnv>();

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 公共物品列表。低于警戒线的排前面，方便一眼看到该补货的东西。
 */
items.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, quantity, unit, min_quantity, note, updated_at
         FROM items
        WHERE household_id = ?
        ORDER BY (quantity <= min_quantity) DESC, name ASC`,
    )
    .bind(c.get('householdId'))
    .all<{
      id: string;
      name: string;
      quantity: number;
      unit: string | null;
      min_quantity: number;
      note: string | null;
      updated_at: number;
    }>();

  return c.json({
    items: results.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      minQuantity: i.min_quantity,
      note: i.note,
      updatedAt: i.updated_at,
      needsRestock: i.quantity <= i.min_quantity,
    })),
  });
});

items.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const name = readString(body.name);
  const unit = readString(body.unit) || null;
  const note = readString(body.note) || null;
  const quantity = typeof body.quantity === 'number' && Number.isInteger(body.quantity) ? body.quantity : 0;
  const minQuantity =
    typeof body.minQuantity === 'number' && Number.isInteger(body.minQuantity) ? body.minQuantity : 0;

  if (!name) return c.json({ error: '请填写物品名称' }, 400);
  if (name.length > 30) return c.json({ error: '名称最多 30 个字' }, 400);
  if (quantity < 0) return c.json({ error: '数量不能为负数' }, 400);
  if (minQuantity < 0) return c.json({ error: '警戒数量不能为负数' }, 400);

  const id = newId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO items (id, household_id, name, quantity, unit, min_quantity, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, c.get('householdId'), name, quantity, unit, minQuantity, note, now)
    .run();

  return c.json({ item: { id, name, quantity, unit, minQuantity, note, updatedAt: now } }, 201);
});

/**
 * 修改物品。
 *
 * `quantity` 传绝对值；`delta` 传增减量（买了两包传 +2，用掉一包传 -1）。
 *
 * delta 用 `quantity = quantity + ?` 在 SQL 里直接算，不做「先读再写」——
 * 两个人同时点「用掉一个」时，读-改-写会丢掉其中一次更新（后写的覆盖先写的），
 * 而原子更新不会。
 */
items.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'items', id, householdId))) {
    return c.json({ error: '物品不存在' }, 404);
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
  if ('unit' in body) {
    fields.push('unit = ?');
    values.push(readString(body.unit) || null);
  }
  if ('note' in body) {
    fields.push('note = ?');
    values.push(readString(body.note) || null);
  }
  if ('minQuantity' in body) {
    const minQuantity = body.minQuantity;
    if (typeof minQuantity !== 'number' || !Number.isInteger(minQuantity) || minQuantity < 0) {
      return c.json({ error: '警戒数量必须是非负整数' }, 400);
    }
    fields.push('min_quantity = ?');
    values.push(minQuantity);
  }

  if ('delta' in body) {
    const delta = body.delta;
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
      return c.json({ error: '增减量必须是非零整数' }, 400);
    }
    // 原子自增，避免并发丢更新
    fields.push('quantity = MAX(0, quantity + ?)');
    values.push(delta);
  } else if ('quantity' in body) {
    const quantity = body.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return c.json({ error: '数量必须是非负整数' }, 400);
    }
    fields.push('quantity = ?');
    values.push(quantity);
  }

  if (fields.length === 0) return c.json({ error: '没有需要更新的字段' }, 400);

  fields.push('updated_at = ?');
  values.push(Date.now());

  values.push(id, householdId);
  await db
    .prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

items.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const db = c.env.DB;

  if (!(await ownedByHousehold(db, 'items', id, householdId))) {
    return c.json({ error: '物品不存在' }, 404);
  }

  await db.prepare('DELETE FROM items WHERE id = ? AND household_id = ?').bind(id, householdId).run();

  return c.json({ ok: true });
});

export default items;
