import { Hono } from 'hono';
import { newId } from '../ids';
import type { AppEnv } from '../env';

const announcements = new Hono<AppEnv>();

const MAX_TITLE = 60;
const MAX_CONTENT = 2000;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 置顶的排前面，其余按时间倒序。 */
announcements.get('/', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

  const { results } = await db
    .prepare(
      `SELECT a.id, a.title, a.content, a.is_pinned, a.created_at, a.author_id, m.name AS author_name
         FROM announcements a
         JOIN members m ON m.id = a.author_id
        WHERE a.household_id = ?
        ORDER BY a.is_pinned DESC, a.created_at DESC
        LIMIT ?`,
    )
    .bind(c.get('householdId'), limit)
    .all<{
      id: string;
      title: string;
      content: string;
      is_pinned: number;
      created_at: number;
      author_id: string;
      author_name: string;
    }>();

  return c.json({
    announcements: results.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      isPinned: a.is_pinned === 1,
      authorId: a.author_id,
      authorName: a.author_name,
      createdAt: a.created_at,
    })),
  });
});

announcements.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const title = readString(body.title);
  const content = readString(body.content);
  const isPinned = body.isPinned ? 1 : 0;

  if (!title) return c.json({ error: '请填写标题' }, 400);
  if (title.length > MAX_TITLE) return c.json({ error: `标题最多 ${MAX_TITLE} 个字` }, 400);
  if (!content) return c.json({ error: '请填写内容' }, 400);
  if (content.length > MAX_CONTENT) return c.json({ error: `内容最多 ${MAX_CONTENT} 个字` }, 400);

  const id = newId();
  const now = Date.now();

  await db
    .prepare(
      `INSERT INTO announcements (id, household_id, title, content, is_pinned, author_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, c.get('householdId'), title, content, isPinned, c.get('memberId'), now)
    .run();

  return c.json(
    {
      announcement: {
        id,
        title,
        content,
        isPinned: isPinned === 1,
        authorId: c.get('memberId'),
        authorName: c.get('memberName'),
        createdAt: now,
      },
    },
    201,
  );
});

/**
 * 取公告并确认它属于当前房间，顺带带回作者。
 *
 * 没有复用 `ownedByHousehold`：那个只回一个 `1 AS ok`，这里还要拿 author_id
 * 跟当前成员比对，而**多跑一次 SELECT 就是多一次 D1 往返**（这套架构里
 * CPU 大头在 D1，不在 PBKDF2）。一次查询把归属和作者一起取回来更划算。
 */
async function findAnnouncement(
  db: D1Database,
  id: string,
  householdId: string,
): Promise<{ authorId: string } | null> {
  return db
    .prepare('SELECT author_id AS authorId FROM announcements WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .first<{ authorId: string }>();
}

/** 改别人的公告时统一的拒绝话术。 */
const NOT_AUTHOR_EDIT = '只有作者能改自己的公告';
const NOT_AUTHOR_DELETE = '只有作者能删自己的公告';

announcements.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const existing = await findAnnouncement(db, id, householdId);
  if (!existing) {
    return c.json({ error: '公告不存在' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  // ⚠️ 校验必须**按字段**做，不能加在整个 PATCH 上。
  //
  //    「编辑标题/内容」和「置顶」是两种不同的操作，前端的渲染条件也不一样：
  //    置顶按钮对**所有人**渲染（见 Announcements.tsx），编辑按钮只对作者。
  //    所以如果在这里写一句 `if (authorId !== memberId) return 403`，
  //    就会把置顶一起锁掉——而那颗按钮对每个人都是可见的，非作者一点就吃
  //    403，看起来像按钮坏了。
  //
  //    分界线：**动内容的是作者的，改展示位置的（置顶）是全房间的。**
  if (('title' in body || 'content' in body) && existing.authorId !== memberId) {
    return c.json({ error: NOT_AUTHOR_EDIT }, 403);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if ('title' in body) {
    const title = readString(body.title);
    if (!title) return c.json({ error: '标题不能为空' }, 400);
    if (title.length > MAX_TITLE) return c.json({ error: `标题最多 ${MAX_TITLE} 个字` }, 400);
    fields.push('title = ?');
    values.push(title);
  }
  if ('content' in body) {
    const content = readString(body.content);
    if (!content) return c.json({ error: '内容不能为空' }, 400);
    if (content.length > MAX_CONTENT) return c.json({ error: `内容最多 ${MAX_CONTENT} 个字` }, 400);
    fields.push('content = ?');
    values.push(content);
  }
  if ('isPinned' in body) {
    fields.push('is_pinned = ?');
    values.push(body.isPinned ? 1 : 0);
  }

  if (fields.length === 0) return c.json({ error: '没有需要更新的字段' }, 400);

  values.push(id, householdId);
  await db
    .prepare(`UPDATE announcements SET ${fields.join(', ')} WHERE id = ? AND household_id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

/**
 * 删除。和改内容一样只认作者。
 *
 * 删除比编辑更不可逆（没有「恢复」），所以这里**没有**为了让位给
 * 「作者退租了怎么办」而放宽——见下面那段注释。
 */
announcements.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const householdId = c.get('householdId');
  const memberId = c.get('memberId');
  const db = c.env.DB;

  const existing = await findAnnouncement(db, id, householdId);
  if (!existing) {
    return c.json({ error: '公告不存在' }, 404);
  }
  if (existing.authorId !== memberId) {
    return c.json({ error: NOT_AUTHOR_DELETE }, 403);
  }

  await db
    .prepare('DELETE FROM announcements WHERE id = ? AND household_id = ?')
    .bind(id, householdId)
    .run();

  return c.json({ ok: true });
});

export default announcements;
