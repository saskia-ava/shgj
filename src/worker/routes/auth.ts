import { Hono } from 'hono';
import {
  buildLogoutCookie,
  buildSessionCookie,
  clearFailedAttempts,
  createSession,
  destroySession,
  hashPin,
  isLocked,
  lockRemainingSeconds,
  readSessionCookie,
  recordFailedAttempt,
  validatePin,
  verifyPin,
  SESSION_TTL_MS,
} from '../auth';
import { newId, newInviteCode, normalizeInviteCode } from '../ids';
import { requireAuth } from '../guards';
import type { AppEnv } from '../env';

const auth = new Hono<AppEnv>();

/** 会话有效期的秒数，用于 cookie 的 Max-Age。 */
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 缺少 pepper 时给出明确指引，而不是让哈希算出一个不安全的值。 */
function requirePepper(pepper: string | undefined): string | null {
  return pepper && pepper.length >= 16 ? pepper : null;
}

// ── 创建房间 ──────────────────────────────────────────────────────

auth.post('/household', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const householdName = readString(body.householdName) || '我们的合租房';
  const memberName = readString(body.memberName);
  const room = readString(body.room) || null;
  const pin = body.pin;

  if (!memberName) return c.json({ error: '请填写你的名字' }, 400);
  if (memberName.length > 20) return c.json({ error: '名字最多 20 个字' }, 400);

  const pinError = validatePin(pin);
  if (pinError) return c.json({ error: pinError }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json({ error: '服务端未配置 PIN_PEPPER 密钥' }, 500);

  const db = c.env.DB;
  const now = Date.now();

  const householdId = newId();
  const memberId = newId();
  const inviteCode = newInviteCode();
  const pinHash = await hashPin(pin as string, pepper);

  await db.batch([
    db
      .prepare('INSERT INTO households (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)')
      .bind(householdId, householdName, inviteCode, now),
    db
      .prepare(
        `INSERT INTO members
           (id, household_id, name, room, move_in, is_active, pin_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(memberId, householdId, memberName, room, now, pinHash, now),
  ]);

  const { token } = await createSession(db, householdId, memberId);

  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));
  return c.json({
    household: { id: householdId, name: householdName, inviteCode },
    member: { id: memberId, name: memberName, room },
  });
});

// ── 查房间（加入前的预览，不泄露成员隐私）─────────────────────────

auth.get('/household/:code', async (c) => {
  const code = normalizeInviteCode(c.req.param('code'));
  const db = c.env.DB;

  const household = await db
    .prepare('SELECT id, name FROM households WHERE invite_code = ?')
    .bind(code)
    .first<{ id: string; name: string }>();

  if (!household) return c.json({ error: '邀请码不存在，请检查后重试' }, 404);

  // 只返回名字和是否已设 PIN，不返回房间号、手机号等隐私信息。
  // has_pin 用来提示用户「这个名字已被占用」还是「可以认领」。
  const { results } = await db
    .prepare(
      `SELECT id, name, (pin_hash IS NOT NULL) AS has_pin
         FROM members
        WHERE household_id = ? AND is_active = 1
        ORDER BY created_at ASC`,
    )
    .bind(household.id)
    .all<{ id: string; name: string; has_pin: number }>();

  return c.json({
    household: { id: household.id, name: household.name },
    members: results.map((m) => ({ id: m.id, name: m.name, hasPin: m.has_pin === 1 })),
  });
});

// ── 加入 / 认领身份 ───────────────────────────────────────────────

auth.post('/join', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const code = normalizeInviteCode(readString(body.inviteCode));
  const name = readString(body.name);
  const room = readString(body.room) || null;
  const pin = body.pin;

  if (!code) return c.json({ error: '请填写邀请码' }, 400);
  if (!name) return c.json({ error: '请填写你的名字' }, 400);
  if (name.length > 20) return c.json({ error: '名字最多 20 个字' }, 400);

  const pinError = validatePin(pin);
  if (pinError) return c.json({ error: pinError }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json({ error: '服务端未配置 PIN_PEPPER 密钥' }, 500);

  const db = c.env.DB;
  const household = await db
    .prepare('SELECT id, name FROM households WHERE invite_code = ?')
    .bind(code)
    .first<{ id: string; name: string }>();

  if (!household) return c.json({ error: '邀请码不存在，请检查后重试' }, 404);

  const now = Date.now();
  const pinHash = await hashPin(pin as string, pepper);

  // 若同名成员已存在且尚未设置 PIN，则认领它——这样先由别人代建的成员
  // 不会变成重复条目，历史账目也能接上。
  const existing = await db
    .prepare('SELECT id, pin_hash FROM members WHERE household_id = ? AND name = ? AND is_active = 1')
    .bind(household.id, name)
    .first<{ id: string; pin_hash: string | null }>();

  let memberId: string;

  if (existing) {
    if (existing.pin_hash) {
      return c.json({ error: '这个名字已经被占用了，换一个，或直接登录' }, 409);
    }
    memberId = existing.id;
    await db
      .prepare('UPDATE members SET pin_hash = ?, room = COALESCE(?, room) WHERE id = ?')
      .bind(pinHash, room, memberId)
      .run();
  } else {
    memberId = newId();
    await db
      .prepare(
        `INSERT INTO members
           (id, household_id, name, room, move_in, is_active, pin_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(memberId, household.id, name, room, now, pinHash, now)
      .run();
  }

  const { token } = await createSession(db, household.id, memberId);

  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));
  return c.json({
    household: { id: household.id, name: household.name },
    member: { id: memberId, name, room },
  });
});

// ── 登录 ──────────────────────────────────────────────────────────

auth.post('/login', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);

  const code = normalizeInviteCode(readString(body.inviteCode));
  const memberId = readString(body.memberId);
  const pin = typeof body.pin === 'string' ? body.pin : '';

  if (!code || !memberId) return c.json({ error: '请选择你的名字' }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json({ error: '服务端未配置 PIN_PEPPER 密钥' }, 500);

  const db = c.env.DB;
  const member = await db
    .prepare(
      `SELECT m.id, m.name, m.pin_hash, m.failed_tries, m.locked_until, m.is_active, m.household_id
         FROM members m
         JOIN households h ON h.id = m.household_id
        WHERE m.id = ? AND h.invite_code = ?`,
    )
    .bind(memberId, code)
    .first<{
      id: string;
      name: string;
      pin_hash: string | null;
      failed_tries: number;
      locked_until: number | null;
      is_active: number;
      household_id: string;
    }>();

  if (!member || member.is_active !== 1) {
    return c.json({ error: '成员不存在或已退租' }, 404);
  }

  // 限速检查必须在验密之前，否则锁定形同虚设
  if (isLocked(member)) {
    const seconds = lockRemainingSeconds(member);
    return c.json(
      { error: `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试` },
      429,
    );
  }

  if (!member.pin_hash) {
    return c.json({ error: '这个身份还没设置 PIN，请用邀请码加入并设置' }, 400);
  }

  const ok = await verifyPin(pin, member.pin_hash, pepper);

  if (!ok) {
    await recordFailedAttempt(db, member.id);
    // 不透露还剩几次机会，避免帮攻击者判断进度
    return c.json({ error: 'PIN 不正确' }, 401);
  }

  await clearFailedAttempts(db, member.id);
  const { token } = await createSession(db, member.household_id, member.id);

  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));
  return c.json({
    member: { id: member.id, name: member.name },
    household: { id: member.household_id },
  });
});

// ── 登出 ──────────────────────────────────────────────────────────

auth.post('/logout', async (c) => {
  const token = readSessionCookie(c.req.header('Cookie'));
  if (token) {
    await destroySession(c.env.DB, token);
  }
  c.header('Set-Cookie', buildLogoutCookie());
  return c.json({ ok: true });
});

// ── 当前登录者 ────────────────────────────────────────────────────

auth.get('/me', requireAuth, async (c) => {
  const db = c.env.DB;
  const householdId = c.get('householdId');

  const [household, member] = await Promise.all([
    db
      .prepare('SELECT id, name, invite_code FROM households WHERE id = ?')
      .bind(householdId)
      .first<{ id: string; name: string; invite_code: string }>(),
    db
      .prepare('SELECT id, name, room, phone FROM members WHERE id = ?')
      .bind(c.get('memberId'))
      .first<{ id: string; name: string; room: string | null; phone: string | null }>(),
  ]);

  if (!household || !member) {
    return c.json({ error: '账号信息异常，请重新登录' }, 401);
  }

  return c.json({
    household: { id: household.id, name: household.name, inviteCode: household.invite_code },
    member,
  });
});

export default auth;
