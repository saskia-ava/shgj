import { Hono } from 'hono';
import {
  buildLogoutCookie,
  buildSessionCookie,
  clearFailedAttempts,
  createSession,
  destroySession,
  dummyVerify,
  hashPassword,
  hashPin,
  hashRecoveryCode,
  hashSessionToken,
  isLocked,
  lockRemainingSeconds,
  lookupSession,
  readSessionCookie,
  recordFailedAttempt,
  revokeOtherSessions,
  validatePin,
  verifySecret,
  PASSWORD_VERIFY_TTL_MS,
  RECOVERY_CODE_COUNT,
  SESSION_TTL_MS,
} from '../auth';
import { newId, newInviteCode, newRecoveryCode, normalizeInviteCode } from '../ids';
import { requireSession } from '../guards';
import { errorBody } from '../../shared/errors';
import { normalizeEmail, validateEmail, validatePassword } from '../../shared/email';
import type { AppEnv } from '../env';

const auth = new Hono<AppEnv>();

/** 会话有效期的秒数，用于 cookie 的 Max-Age。 */
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

const MAX_NAME_LENGTH = 20;
const MAX_HOUSEHOLD_NAME_LENGTH = 30;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 缺少 pepper 时给出明确指引，而不是让哈希算出一个不安全的值。 */
function requirePepper(pepper: string | undefined): string | null {
  return pepper && pepper.length >= 16 ? pepper : null;
}

const PEPPER_MISSING = { error: '服务端未配置 PIN_PEPPER 密钥', code: 'FORBIDDEN' } as const;

/** 唯一约束冲突。用来把数据库层的兜底错误翻译成人话。 */
function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
}

// ── 共用：组装登录态 ──────────────────────────────────────────────

interface MembershipRow {
  id: string;
  name: string;
  room: string | null;
  household_id: string;
  household_name: string;
  invite_code: string;
  created_at: number;
}

/**
 * 组装 /me 的返回体。注册、登录、加入、切换房间都复用它。
 *
 * `household` / `member` 这两个字段的形状和重构前**完全一致**（只是现在可能
 * 为 null），前端 7 个页面里 15 处 `session.member.id` 因此一行都不用改。
 */
async function buildSessionPayload(
  db: D1Database,
  accountId: string,
  activeHouseholdId: string | null,
) {
  const [account, memberships] = await Promise.all([
    db
      .prepare('SELECT id, email, email_verified FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ id: string; email: string; email_verified: number }>(),
    db
      .prepare(
        `SELECT m.id, m.name, m.room, m.household_id,
                h.name AS household_name, h.invite_code, m.created_at
           FROM members m
           JOIN households h ON h.id = m.household_id
          WHERE m.account_id = ? AND m.is_active = 1
          ORDER BY m.created_at DESC`,
      )
      .bind(accountId)
      .all<MembershipRow>(),
  ]);

  const list = memberships.results;
  const active = list.find((m) => m.household_id === activeHouseholdId) ?? null;

  return {
    account: account
      ? { id: account.id, email: account.email, emailVerified: account.email_verified === 1 }
      : null,
    households: list.map((m) => ({
      id: m.household_id,
      name: m.household_name,
      inviteCode: m.invite_code,
      memberId: m.id,
      memberName: m.name,
      room: m.room,
    })),
    household: active
      ? { id: active.household_id, name: active.household_name, inviteCode: active.invite_code }
      : null,
    member: active ? { id: active.id, name: active.name, room: active.room, phone: null } : null,
  };
}

/**
 * 把会话的当前房间切过去。
 *
 * ⚠️ 授权判断写在 UPDATE 的 WHERE 里，一条语句完成，中间没有「先查再改」的
 *    时间窗。检查 meta.changes === 1 而不是相信请求体里传来的 householdId ——
 *    没有这个 EXISTS，任何登录用户都能把自己的会话切到别人家的房间上。
 */
async function setActiveHousehold(
  db: D1Database,
  token: string,
  accountId: string,
  householdId: string,
): Promise<boolean> {
  const tokenHash = await hashSessionToken(token);
  const result = await db
    .prepare(
      `UPDATE sessions SET active_household_id = ?1
        WHERE token = ?2
          AND EXISTS (
                SELECT 1 FROM members
                 WHERE account_id = ?3 AND household_id = ?1 AND is_active = 1
              )`,
    )
    .bind(householdId, tokenHash, accountId)
    .run();

  return (result.meta?.changes ?? 0) === 1;
}

/**
 * 生成一组恢复码，返回明文和待执行的 INSERT 语句。
 *
 * 明文只在这一刻存在于内存里，随响应返回一次；数据库里只有哈希，之后
 * 谁也拿不回来。哈希是异步的（crypto.subtle），所以这里返回语句而不是直接执行。
 */
async function buildRecoveryCodes(
  db: D1Database,
  accountId: string,
  now: number,
): Promise<{ plain: string[]; statements: D1PreparedStatement[] }> {
  const plain: string[] = [];
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = newRecoveryCode();
    plain.push(code);
    statements.push(
      db
        .prepare(
          'INSERT INTO recovery_codes (account_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)',
        )
        .bind(accountId, await hashRecoveryCode(normalizeInviteCode(code)), now),
    );
  }

  return { plain, statements };
}

// ── 注册 ──────────────────────────────────────────────────────────

/**
 * 注册账号。
 *
 * 注册**不**创建房间也不设 PIN：新账号的 active_household_id 是 NULL，
 * 前端会把他导向「建房 / 用邀请码加入」的选择页。
 * 这样注册路径只跑一次 PBKDF2（算密码哈希）。
 */
auth.post('/register', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const email = normalizeEmail(readString(body.email));
  const password = body.password;

  const emailError = validateEmail(email);
  if (emailError) return c.json({ error: emailError, code: 'INVALID_CREDENTIALS' }, 400);

  const passwordError = validatePassword(password);
  if (passwordError) return c.json({ error: passwordError, code: 'INVALID_CREDENTIALS' }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const now = Date.now();

  const taken = await db
    .prepare('SELECT id FROM accounts WHERE email = ?')
    .bind(email)
    .first();
  if (taken) {
    return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，直接登录即可'), 409);
  }

  // 整个注册路径**只有这一次** PBKDF2
  const passwordHash = await hashPassword(password as string, pepper);
  const accountId = newId();

  const { plain: recoveryPlain, statements: recoveryStatements } = await buildRecoveryCodes(
    db,
    accountId,
    now,
  );

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO accounts (id, email, password_hash, email_verified, failed_tries, locked_until, created_at, updated_at)
           VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`,
        )
        .bind(accountId, email, passwordHash, now, now),
      ...recoveryStatements,
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，直接登录即可'), 409);
    }
    throw err;
  }

  const { token } = await createSession(db, accountId, null);
  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));

  const payload = await buildSessionPayload(db, accountId, null);
  // 恢复码只在这里返回一次，之后数据库里只有哈希，谁也拿不回来。
  return c.json({ ...payload, recoveryCodes: recoveryPlain }, 201);
});

// ── 登录（邮箱 + 密码）────────────────────────────────────────────

auth.post('/login', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const email = normalizeEmail(readString(body.email));
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return c.json(errorBody('INVALID_CREDENTIALS', '请填写邮箱和密码'), 400);
  }

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const account = await db
    .prepare(
      'SELECT id, email, password_hash, failed_tries, locked_until FROM accounts WHERE email = ?',
    )
    .bind(email)
    .first<{
      id: string;
      email: string;
      password_hash: string;
      failed_tries: number;
      locked_until: number | null;
    }>();

  // 账号不存在时也要跑一次等价的 PBKDF2，把 PBKDF2 那一段的耗时拉平。
  // ⚠️ 拉平的**只有** PBKDF2 那一段：下面成功路径还要写两次库（clearFailedAttempts
  //    + createSession），失败路径一次都不写，线上实测墙钟差 120ms。
  //    所以这**不是**一个能防住邮箱枚举的措施，详见 auth.ts 里 dummyVerify 的注释。
  if (!account) {
    await dummyVerify(pepper);
    return c.json(errorBody('INVALID_CREDENTIALS', '邮箱或密码不正确'), 401);
  }

  // 限速检查必须在验密之前，否则锁定形同虚设
  if (isLocked(account)) {
    const seconds = lockRemainingSeconds(account);
    return c.json(
      errorBody('RATE_LIMITED', `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`),
      429,
    );
  }

  const ok = await verifySecret(password, account.password_hash, pepper);
  if (!ok) {
    await recordFailedAttempt(db, 'accounts', account.id);
    // 统一文案，不区分「邮箱不存在」和「密码错」，不透露还剩几次机会
    return c.json(errorBody('INVALID_CREDENTIALS', '邮箱或密码不正确'), 401);
  }

  await clearFailedAttempts(db, 'accounts', account.id);

  // 选一个房间作为当前房间：取最近加入的那个在住房间。
  // 一个都没有时传 null，前端会导向「建房 / 加入」。
  const first = await db
    .prepare(
      `SELECT household_id FROM members
        WHERE account_id = ? AND is_active = 1
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(account.id)
    .first<{ household_id: string }>();

  const { token } = await createSession(db, account.id, first?.household_id ?? null);
  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));

  return c.json(await buildSessionPayload(db, account.id, first?.household_id ?? null));
});

// ── 登录（邀请码 + 我是谁 + PIN）──────────────────────────────────
//
// PIN 是快捷登录，不是主登录方式：它**要求该成员已经绑定账号**。
// 没有账号的成员（由别人代建、还没认领）没有 PIN，也就无法用这条路登录。

auth.post('/login/pin', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const code = normalizeInviteCode(readString(body.inviteCode));
  const memberId = readString(body.memberId);
  const pin = typeof body.pin === 'string' ? body.pin : '';

  if (!code || !memberId) return c.json({ error: '请选择你的名字' }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT m.id, m.name, m.account_id, m.is_active, m.household_id,
              p.pin_hash, p.failed_tries, p.locked_until
         FROM members m
         JOIN households h ON h.id = m.household_id
         LEFT JOIN member_pins p ON p.member_id = m.id
        WHERE m.id = ? AND h.invite_code = ?`,
    )
    .bind(memberId, code)
    .first<{
      id: string;
      name: string;
      account_id: string | null;
      is_active: number;
      household_id: string;
      pin_hash: string | null;
      failed_tries: number | null;
      locked_until: number | null;
    }>();

  if (!row || row.is_active !== 1) {
    return c.json({ error: '成员不存在或已退租' }, 404);
  }

  if (row.locked_until !== null && isLocked({ locked_until: row.locked_until })) {
    const seconds = lockRemainingSeconds({ locked_until: row.locked_until });
    return c.json(
      errorBody('RATE_LIMITED', `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`),
      429,
    );
  }

  if (!row.account_id) {
    return c.json(
      errorBody('INVALID_CREDENTIALS', '这个身份还没有绑定账号，请用邮箱注册后再加入'),
      400,
    );
  }

  if (!row.pin_hash) {
    return c.json(errorBody('INVALID_CREDENTIALS', '这个身份还没设置 PIN，请用邮箱密码登录'), 400);
  }

  // 这一条路径**恰好一次** PBKDF2（PIN_ITERATIONS = 1,000）
  const ok = await verifySecret(pin, row.pin_hash, pepper);
  if (!ok) {
    await recordFailedAttempt(db, 'member_pins', row.id);
    return c.json(errorBody('INVALID_CREDENTIALS', 'PIN 不正确'), 401);
  }

  await clearFailedAttempts(db, 'member_pins', row.id);

  const { token } = await createSession(db, row.account_id, row.household_id);
  c.header('Set-Cookie', buildSessionCookie(token, SESSION_TTL_SECONDS));

  return c.json(await buildSessionPayload(db, row.account_id, row.household_id));
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

  // 只返回名字和「是否已被认领」，不返回房间号、手机号等隐私信息。
  // claimed 用来提示用户「这个名字已经有人了」还是「可以认领」。
  const { results } = await db
    .prepare(
      `SELECT id, name, (account_id IS NOT NULL) AS claimed
         FROM members
        WHERE household_id = ? AND is_active = 1
        ORDER BY created_at ASC`,
    )
    .bind(household.id)
    .all<{ id: string; name: string; claimed: number }>();

  return c.json({
    household: { id: household.id, name: household.name },
    members: results.map((m) => ({ id: m.id, name: m.name, claimed: m.claimed === 1 })),
  });
});

// ── 创建房间 ──────────────────────────────────────────────────────
//
// 两种调用方式，共用同一个端点：
//   - 匿名（第一次用）：body 里带 email + password，会顺带把账号建出来
//   - 已登录（老用户开第二个房间）：带 cookie，**0 次 PBKDF2**
//
// ⚠️ 建房**不再顺带设 PIN**。设 PIN 是建房之后独立的一步（POST /pin），
//    否则建房路径会有两次 PBKDF2（算密码 + 算 PIN），直接超 10ms 预算。

auth.post('/household', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const householdName = readString(body.householdName) || '我们的合租房';
  const memberName = readString(body.memberName);
  const room = readString(body.room) || null;

  if (!memberName) return c.json({ error: '请填写你的名字' }, 400);
  if (memberName.length > MAX_NAME_LENGTH) {
    return c.json({ error: `名字最多 ${MAX_NAME_LENGTH} 个字` }, 400);
  }
  if (householdName.length > MAX_HOUSEHOLD_NAME_LENGTH) {
    return c.json({ error: `房间名最多 ${MAX_HOUSEHOLD_NAME_LENGTH} 个字` }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  // 判断是不是已登录的老用户在开新房间
  const token = readSessionCookie(c.req.header('Cookie'));
  const existing = token ? await lookupSession(db, token) : null;

  let accountId: string;
  let recoveryPlain: string[] | undefined;

  if (existing) {
    accountId = existing.accountId; // 0 次 PBKDF2
  } else {
    const email = normalizeEmail(readString(body.email));
    const emailError = validateEmail(email);
    if (emailError) return c.json({ error: emailError }, 400);

    const passwordError = validatePassword(body.password);
    if (passwordError) return c.json({ error: passwordError }, 400);

    const pepper = requirePepper(c.env.PIN_PEPPER);
    if (!pepper) return c.json(PEPPER_MISSING, 500);

    const taken = await db
      .prepare('SELECT id FROM accounts WHERE email = ?')
      .bind(email)
      .first();
    if (taken) return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录'), 409);

    // 这条路径唯一的一次 PBKDF2
    const passwordHash = await hashPassword(body.password as string, pepper);
    accountId = newId();

    const recovery = await buildRecoveryCodes(db, accountId, now);
    recoveryPlain = recovery.plain;

    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO accounts (id, email, password_hash, email_verified, failed_tries, locked_until, created_at, updated_at)
             VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`,
          )
          .bind(accountId, email, passwordHash, now, now),
        ...recovery.statements,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录'), 409);
      }
      throw err;
    }
  }

  const householdId = newId();
  const memberId = newId();
  const inviteCode = newInviteCode();

  try {
    await db.batch([
      db
        .prepare('INSERT INTO households (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)')
        .bind(householdId, householdName, inviteCode, now),
      db
        .prepare(
          `INSERT INTO members (id, household_id, account_id, name, room, move_in, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(memberId, householdId, accountId, memberName, room, now, now),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        errorBody('CLAIMED_ALREADY', '你在那个房间里已经有身份了，直接切过去即可'),
        409,
      );
    }
    throw err;
  }

  if (existing && token) {
    // 把当前会话切到新房间
    await setActiveHousehold(db, token, accountId, householdId);
    const payload = await buildSessionPayload(db, accountId, householdId);
    return c.json(payload, 201);
  }

  const { token: newToken } = await createSession(db, accountId, householdId);
  c.header('Set-Cookie', buildSessionCookie(newToken, SESSION_TTL_SECONDS));

  const payload = await buildSessionPayload(db, accountId, householdId);
  return c.json(recoveryPlain ? { ...payload, recoveryCodes: recoveryPlain } : payload, 201);
});

// ── 加入房间 ──────────────────────────────────────────────────────
//
// 同样是双模式：匿名（注册 + 加入一步到位）或已登录（加入第二个房间）。

auth.post('/join', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const code = normalizeInviteCode(readString(body.inviteCode));
  const name = readString(body.name);
  const room = readString(body.room) || null;
  const claimMemberId = readString(body.claimMemberId) || null;

  if (!code) return c.json({ error: '请填写邀请码' }, 400);
  if (!name) return c.json({ error: '请填写你的名字' }, 400);
  if (name.length > MAX_NAME_LENGTH) {
    return c.json({ error: `名字最多 ${MAX_NAME_LENGTH} 个字` }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  const household = await db
    .prepare('SELECT id, name FROM households WHERE invite_code = ?')
    .bind(code)
    .first<{ id: string; name: string }>();
  if (!household) return c.json({ error: '邀请码不存在，请检查后重试' }, 404);

  const token = readSessionCookie(c.req.header('Cookie'));
  const existing = token ? await lookupSession(db, token) : null;

  let accountId: string;
  let recoveryPlain: string[] | undefined;
  let createdAccountId: string | null = null;

  if (existing) {
    accountId = existing.accountId; // 0 次 PBKDF2
  } else {
    const email = normalizeEmail(readString(body.email));
    const emailError = validateEmail(email);
    if (emailError) return c.json({ error: emailError }, 400);

    const passwordError = validatePassword(body.password);
    if (passwordError) return c.json({ error: passwordError }, 400);

    const pepper = requirePepper(c.env.PIN_PEPPER);
    if (!pepper) return c.json(PEPPER_MISSING, 500);

    const taken = await db
      .prepare('SELECT id FROM accounts WHERE email = ?')
      .bind(email)
      .first();
    if (taken) return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录'), 409);

    // 这条路径唯一的一次 PBKDF2
    const passwordHash = await hashPassword(body.password as string, pepper);
    accountId = newId();
    createdAccountId = accountId;

    const recovery = await buildRecoveryCodes(db, accountId, now);
    recoveryPlain = recovery.plain;

    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO accounts (id, email, password_hash, email_verified, failed_tries, locked_until, created_at, updated_at)
             VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`,
          )
          .bind(accountId, email, passwordHash, now, now),
        ...recovery.statements,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(errorBody('EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录'), 409);
      }
      throw err;
    }
  }

  // 这个账号在这个房间里的既有身份——在住的、或退过租的都算。
  //
  // ⚠️ 必须把「已退租」也一起捞出来。只看在住的话，退租再搬回来会落到下面的
  //    按名字认领分支，而那条分支要求 `account_id IS NULL`——旧档案的 account_id
  //    正是自己，匹配不上，于是**新建一条**。后果很隐蔽：历史账目留在一条他已经
  //    够不着的旧身份上，Σ balance === 0 这个硬断言**依然成立**（退租者仍参与
  //    计算），但他自己在界面上看到的是负债为零的全新身份，那笔欠款凭空消失。
  //
  //    部分唯一索引 idx_members_account_active 带了 is_active = 1 条件，正是为了
  //    让「退租后再搬回来」这条合法路径复用同一条 members.id。
  const existingMembership = await db
    .prepare(
      `SELECT id, is_active FROM members
        WHERE account_id = ? AND household_id = ?
        ORDER BY is_active DESC, created_at DESC
        LIMIT 1`,
    )
    .bind(accountId, household.id)
    .first<{ id: string; is_active: number }>();

  if (existingMembership) {
    if (existingMembership.is_active !== 1) {
      // 搬回来。members.id 保持不变，历史账目、分摊、结算全都还挂在这个 id 上。
      // 名字和房间按这次填的更新——人还是同一个人（account_id 相同，
      // 这一点是身份依据），只是他换了称呼或换了间房。
      //
      // WHERE 里带 is_active = 0 而不是「先查再改」：并发两次重新加入时，
      // 只有一次能改到，另一条走 UPDATE 的 changes === 0，不会产生第二条在住档案。
      await db
        .prepare(
          `UPDATE members SET is_active = 1, move_out = NULL, name = ?, room = COALESCE(?, room)
            WHERE id = ? AND is_active = 0`,
        )
        .bind(name, room, existingMembership.id)
        .run();
    }

    if (existing && token) await setActiveHousehold(db, token, accountId, household.id);
    else {
      const { token: t } = await createSession(db, accountId, household.id);
      c.header('Set-Cookie', buildSessionCookie(t, SESSION_TTL_SECONDS));
    }
    const payload = await buildSessionPayload(db, accountId, household.id);
    return c.json(recoveryPlain ? { ...payload, recoveryCodes: recoveryPlain } : payload);
  }

  // 决定要认领哪条档案：显式指定的优先，否则按同名匹配
  let target: { id: string } | null = null;
  if (claimMemberId) {
    target = await db
      .prepare(
        'SELECT id FROM members WHERE id = ? AND household_id = ? AND is_active = 1 AND account_id IS NULL',
      )
      .bind(claimMemberId, household.id)
      .first<{ id: string }>();
    if (!target) {
      await rollbackAccount(db, createdAccountId);
      return c.json(
        errorBody('CLAIMED_ALREADY', '这个身份已经被别人认领了，换一个名字，或直接登录'),
        409,
      );
    }
  } else {
    target = await db
      .prepare(
        'SELECT id FROM members WHERE household_id = ? AND name = ? AND is_active = 1 AND account_id IS NULL',
      )
      .bind(household.id, name)
      .first<{ id: string }>();

    // 没有可认领的同名档案——但这个名字可能已经被别人占了。
    //
    // 不挡的话会静静建出第二个「小红」，而**不报错**。后果不是账目算错
    // （成员 id 不同，余额仍然正确），而是界面变得没法用：PIN 登录页会让
    // 用户在两个一模一样的「小红」里猜哪个是自己；记账时也一样。
    // 真实世界里确实有同名的人，所以这里不是禁止同名，而是要求加个区分。
    //
    // 只看在住的：退租过的同名成员不该挡住新室友入住。
    if (!target) {
      const taken = await db
        .prepare('SELECT id FROM members WHERE household_id = ? AND name = ? AND is_active = 1')
        .bind(household.id, name)
        .first<{ id: string }>();
      if (taken) {
        await rollbackAccount(db, createdAccountId);
        return c.json(
          errorBody(
            'CLAIMED_ALREADY',
            `房间里已经有一个叫「${name}」的成员了，加个能区分的写法（比如「${name} A」）再试`,
          ),
          409,
        );
      }
    }
  }

  let memberId: string;

  if (target) {
    memberId = target.id;
    // ⚠️ 条件 UPDATE + 检查 changes，**绝不能写成「先 SELECT 再 UPDATE」**。
    //    两个请求同时认领同一个档案时，后者会顶替前者并继承对方的余额——
    //    WHERE 里的 account_id IS NULL 是唯一能挡住这件事的地方。
    const result = await db
      .prepare(
        `UPDATE members SET account_id = ?1, room = COALESCE(?2, room)
          WHERE id = ?3 AND household_id = ?4 AND is_active = 1 AND account_id IS NULL`,
      )
      .bind(accountId, room, memberId, household.id)
      .run();

    if ((result.meta?.changes ?? 0) !== 1) {
      await rollbackAccount(db, createdAccountId);
      return c.json(
        errorBody('CLAIMED_ALREADY', '这个身份刚刚被认领了，换一个名字，或直接登录'),
        409,
      );
    }
  } else {
    memberId = newId();
    try {
      await db
        .prepare(
          `INSERT INTO members (id, household_id, account_id, name, room, move_in, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(memberId, household.id, accountId, name, room, now, now)
        .run();
    } catch (err) {
      await rollbackAccount(db, createdAccountId);
      // idx_members_account_active 兜底：同账号同房间不能有两条在住档案
      if (isUniqueViolation(err)) {
        return c.json(
          errorBody('CLAIMED_ALREADY', '你在那个房间里已经有身份了，直接切过去即可'),
          409,
        );
      }
      throw err;
    }
  }

  if (existing && token) {
    await setActiveHousehold(db, token, accountId, household.id);
  } else {
    const { token: newToken } = await createSession(db, accountId, household.id);
    c.header('Set-Cookie', buildSessionCookie(newToken, SESSION_TTL_SECONDS));
  }

  const payload = await buildSessionPayload(db, accountId, household.id);
  return c.json(recoveryPlain ? { ...payload, recoveryCodes: recoveryPlain } : payload, 201);
});

/**
 * 注册/加入失败时回滚刚刚创建的账号。
 *
 * 只在「本请求刚建的账号」上调用（createdAccountId 为 null 时是空操作），
 * 因此不会误删别人的账号。留着它的坏处更大：用户会卡在
 * 「邮箱已被注册」但自己又没有可用身份的状态里。
 */
async function rollbackAccount(db: D1Database, accountId: string | null): Promise<void> {
  if (!accountId) return;
  await db.batch([
    db.prepare('DELETE FROM recovery_codes WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(accountId),
    db.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
  ]);
}

// ── 当前登录者 ────────────────────────────────────────────────────

auth.get('/me', requireSession, async (c) => {
  const session = c.get('session');
  return c.json(
    await buildSessionPayload(c.env.DB, session.accountId, session.activeHouseholdId),
  );
});

// ── 切换当前房间 ──────────────────────────────────────────────────

auth.post('/switch', requireSession, async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const householdId = readString(body.householdId);
  if (!householdId) return c.json({ error: '请指定要切换的房间' }, 400);

  const token = readSessionCookie(c.req.header('Cookie'));
  const session = c.get('session');
  if (!token) return c.json(errorBody('SESSION_EXPIRED', '登录已过期，请重新登录'), 401);

  // 授权在 SQL 的 WHERE 里做，见 setActiveHousehold 的注释
  const ok = await setActiveHousehold(c.env.DB, token, session.accountId, householdId);
  if (!ok) {
    return c.json(errorBody('FORBIDDEN', '你不在这个房间里'), 403);
  }

  return c.json(await buildSessionPayload(c.env.DB, session.accountId, householdId));
});

// ── 改密码（第一步：验旧密码）─────────────────────────────────────
//
// 拆成两个请求是为了守住「一个请求最多一次 PBKDF2」：验旧密码一次，
// 算新密码一次，各在自己的请求里。
//
// 不采用「有会话就直接改、不验旧密码」的方案：那能防住会话被盗，
// 但防不住「有人趁你没锁屏走过来把密码改掉」。

auth.post('/password/verify', requireSession, async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return c.json({ error: '请填写当前密码' }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const session = c.get('session');
  const token = readSessionCookie(c.req.header('Cookie'));
  if (!token) return c.json(errorBody('SESSION_EXPIRED', '登录已过期，请重新登录'), 401);

  const account = await db
    .prepare('SELECT password_hash FROM accounts WHERE id = ?')
    .bind(session.accountId)
    .first<{ password_hash: string }>();
  if (!account) return c.json(errorBody('SESSION_EXPIRED', '账号不存在'), 401);

  // 这条路径恰好一次 PBKDF2
  const ok = await verifySecret(password, account.password_hash, pepper);
  if (!ok) return c.json(errorBody('INVALID_CREDENTIALS', '当前密码不正确'), 401);

  const { hashSessionToken } = await import('../auth');
  await db
    .prepare('UPDATE sessions SET password_verified_at = ? WHERE token = ?')
    .bind(Date.now(), await hashSessionToken(token))
    .run();

  return c.json({ ok: true, expiresInMs: PASSWORD_VERIFY_TTL_MS });
});

// ── 改密码（第二步：设置新密码）───────────────────────────────────

auth.post('/password', requireSession, async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const passwordError = validatePassword(body.newPassword);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const session = c.get('session');
  const token = readSessionCookie(c.req.header('Cookie'));
  if (!token) return c.json(errorBody('SESSION_EXPIRED', '登录已过期，请重新登录'), 401);

  if (
    !session.passwordVerifiedAt ||
    Date.now() - session.passwordVerifiedAt > PASSWORD_VERIFY_TTL_MS
  ) {
    return c.json(
      errorBody('FORBIDDEN', '请先验证当前密码，验证结果 5 分钟内有效'),
      403,
    );
  }

  // 这条路径恰好一次 PBKDF2
  const passwordHash = await hashPassword(body.newPassword as string, pepper);
  const now = Date.now();

  const tokenHash = await hashSessionToken(token);

  await db.batch([
    db
      .prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, now, session.accountId),
    // 消费掉这次验证凭证，避免同一个凭证被用来反复改密码
    db.prepare('UPDATE sessions SET password_verified_at = NULL WHERE token = ?').bind(tokenHash),
  ]);

  // 把其它设备踢下线：改密码应当能应对「某个令牌已经泄露」的情况
  await revokeOtherSessions(db, session.accountId, token);

  return c.json({ ok: true });
});

// ── 用恢复码重置密码 ──────────────────────────────────────────────
//
// 在能发邮件之前（第五期之前），这是唯一能自助找回密码的途径。

auth.post('/recovery', async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const email = normalizeEmail(readString(body.email));
  const code = normalizeInviteCode(readString(body.code));
  const passwordError = validatePassword(body.newPassword);

  if (!email || !code) return c.json({ error: '请填写邮箱和恢复码' }, 400);
  if (passwordError) return c.json({ error: passwordError }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const account = await db
    .prepare('SELECT id FROM accounts WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();

  // 不区分「邮箱不存在」和「恢复码不对」，避免变成邮箱枚举接口
  if (!account) {
    await dummyVerify(pepper);
    return c.json(errorBody('INVALID_CREDENTIALS', '邮箱或恢复码不正确'), 401);
  }

  const now = Date.now();
  const codeHash = await hashRecoveryCode(code);

  // ⚠️ 消费恢复码必须是条件 UPDATE + 检查 changes：
  //    写成「先查有没有用过、再标记已用」的话，同一个码并发提交两次就能
  //    通过两次校验，等于一次性的性质没了。
  const consumed = await db
    .prepare(
      `UPDATE recovery_codes SET used_at = ?1
        WHERE account_id = ?2 AND code_hash = ?3 AND used_at IS NULL`,
    )
    .bind(now, account.id, codeHash)
    .run();

  if ((consumed.meta?.changes ?? 0) !== 1) {
    return c.json(errorBody('INVALID_CREDENTIALS', '邮箱或恢复码不正确'), 401);
  }

  // 这条路径恰好一次 PBKDF2
  const passwordHash = await hashPassword(body.newPassword as string, pepper);

  await db.batch([
    db
      .prepare('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(passwordHash, now, account.id),
    // 恢复码意味着「账号可能已被他人拿到」，把所有会话清掉
    db.prepare('DELETE FROM sessions WHERE account_id = ?').bind(account.id),
  ]);

  c.header('Set-Cookie', buildLogoutCookie());
  return c.json({ ok: true });
});

// ── 重设恢复码 ────────────────────────────────────────────────────

auth.post('/recovery-codes', requireSession, async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return c.json({ error: '请填写当前密码' }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const session = c.get('session');

  const account = await db
    .prepare('SELECT password_hash FROM accounts WHERE id = ?')
    .bind(session.accountId)
    .first<{ password_hash: string }>();
  if (!account) return c.json(errorBody('SESSION_EXPIRED', '账号不存在'), 401);

  // 这条路径恰好一次 PBKDF2
  const ok = await verifySecret(password, account.password_hash, pepper);
  if (!ok) return c.json(errorBody('INVALID_CREDENTIALS', '密码不正确'), 401);

  const now = Date.now();
  const { plain, statements } = await buildRecoveryCodes(db, session.accountId, now);

  await db.batch([
    // 旧的恢复码全部作废：重设的语义就是「之前那张纸没用了」
    db.prepare('DELETE FROM recovery_codes WHERE account_id = ?').bind(session.accountId),
    ...statements,
  ]);

  return c.json({ recoveryCodes: plain });
});

// ── 设置 / 修改当前房间的 PIN ─────────────────────────────────────
//
// ⚠️ 路径里**没有成员 id**，PIN 作用在「当前会话所在房间里的自己」身上。
//    重构前是 POST /api/members/:id/pin，那等于把越权面直接开在 URL 上。
//
// 轮数是 1,000，所以「验旧 PIN + 算新 PIN」两次也仍在 CPU 预算内。

auth.post('/pin', requireSession, async (c) => {
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);

  const session = c.get('session');
  if (!session.activeHouseholdId || !session.memberId) {
    return c.json(errorBody('NO_MEMBERSHIP', '请先选择一个房间'), 403);
  }

  const pinError = validatePin(body.pin);
  if (pinError) return c.json({ error: pinError }, 400);

  const pepper = requirePepper(c.env.PIN_PEPPER);
  if (!pepper) return c.json(PEPPER_MISSING, 500);

  const db = c.env.DB;
  const existingPin = await db
    .prepare('SELECT pin_hash FROM member_pins WHERE member_id = ?')
    .bind(session.memberId)
    .first<{ pin_hash: string }>();

  if (existingPin) {
    // 已经有 PIN，必须先验旧的，否则任何人都能趁别人没锁屏改掉 PIN
    const current = typeof body.currentPin === 'string' ? body.currentPin : '';
    if (!current) return c.json({ error: '请输入当前 PIN' }, 400);

    const ok = await verifySecret(current, existingPin.pin_hash, pepper);
    if (!ok) return c.json(errorBody('INVALID_CREDENTIALS', '当前 PIN 不正确'), 401);
  }

  const pinHash = await hashPin(body.pin as string, pepper);

  await db
    .prepare(
      `INSERT INTO member_pins (member_id, pin_hash, failed_tries, locked_until, updated_at)
       VALUES (?, ?, 0, NULL, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         pin_hash = excluded.pin_hash,
         failed_tries = 0,
         locked_until = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(session.memberId, pinHash, Date.now())
    .run();

  return c.json({ ok: true });
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

export default auth;
