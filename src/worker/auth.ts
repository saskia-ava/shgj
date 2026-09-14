/**
 * 认证：密码/PIN 哈希、会话签发与校验、暴力破解限速、恢复码。
 *
 * ⚠️⚠️ **任何一个请求最多只做一次 PBKDF2。** ⚠️⚠️
 *
 * 这是本项目最重要的性能纪律，也是结构性的、不靠记性的那种：
 * 单次 6,000 轮在本机约 2~4ms，折算到 Cloudflare 就是 6~12ms，
 * 两次直接吃掉免费版每请求 10ms 的 CPU 预算（超限报 Error 1102，接口直接失败）。
 *
 * 为了让这条规则成立，架构上做了三处让步：
 *   - PIN 用 1,000 轮（不是 6,000），所以「验旧 PIN + 算新 PIN」这个
 *     唯一的两段式路径仍然安全
 *   - 改密码拆成两个请求，每个只跑一次 PBKDF2（见 routes/auth.ts）
 *   - 建房/加入房间不再顺带设 PIN，PIN 是建房之后独立的一步
 *
 * 还有一条**明确不做**的：不要为了「升级轮数」在登录成功时静默重算哈希。
 * 那会给每次成功登录都加上第二次 PBKDF2，而且只在成功路径上触发——
 * 是最不容易被注意到的超限方式。轮数写在哈希串里，老哈希本来也校验得了。
 *
 * ── 轮数是怎么定的 ────────────────────────────────────────────────
 * 轮数是在线上实测出来的，不是照推荐值抄的。踩过的坑：
 *
 *   本机 Node 跑 PBKDF2-SHA256 25,000 轮只要 3.3ms，
 *   但同一段代码在 Cloudflare 上要 10~13ms——差了 3 倍多。
 *   照本机基准去选轮数，线上必然翻车。
 *
 * 线上实测（`wrangler tail --format json` 读 cpuTime）：
 *   PBKDF2-SHA256 25,000 轮 → 登录接口整体 10~14ms，创建房间 17ms  ← 超限
 *   PBKDF2-SHA256  6,000 轮 → 见下方注释，留出余量
 *   HMAC-SHA256             → 0.08ms，几乎免费
 *
 * 架构是 [HMAC-SHA256(pepper) → PBKDF2(n 轮)]。
 * pepper 是不入库的高熵密钥，承担了主要的抗离线爆破职责——攻击者拖走数据库
 * 也缺一半输入，拿不到 pepper 就一步都走不了。PBKDF2 是第二道防线，
 * 只在「数据库和 pepper 同时泄露」时才有意义，因此轮数可以压到 CPU 预算之内。
 *
 * 关于 4 位 PIN：就算按 OWASP 推荐值上 600,000 轮，1 万种组合也只要 30 分钟就能
 * 穷举完，轮数救不了短 PIN。真正拦住猜 PIN 的是登录失败锁定（5 次锁 15 分钟）——
 * 那是硬约束，因为它在服务端累加，绕不过去。想更安全请用长密码短语。
 *
 * 改动轮数不会让老哈希失效：轮数写在哈希串里，校验时从串里读。
 *
 * 另需掐掉一个念头：**不要改成客户端预哈希**。那要求把 pepper 发到浏览器，
 * 等于扔掉「数据库泄露也爆破不动」这个核心性质，还会把 pepper 暴露给每一个用户。
 */

/** 密码用。改高之前必须先线上实测 cpuTime，不能只改数字。 */
export const PASSWORD_ITERATIONS = 6_000;

/**
 * PIN 用。比密码低得多，原因是 PIN 的防线不在哈希强度而在失败锁定
 * （见下方 isLocked 的说明）。压到 1,000 轮是为了让「验旧 PIN + 算新 PIN」
 * 这条路径两次加起来仍在预算内。
 */
export const PIN_ITERATIONS = 1_000;

const PBKDF2_HASH = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;

export const SESSION_COOKIE = 'hzm_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 改密码时，第一步验证通过后的有效期。 */
export const PASSWORD_VERIFY_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 连续失败多少次后锁定 */
export const MAX_FAILED_ATTEMPTS = 5;
/** 锁定时长 */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** PIN 最短长度。允许任意字符，方便用户改用更长的密码短语。 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 64;

/** 注册时一次性生成多少个恢复码。 */
export const RECOVERY_CODE_COUNT = 8;

// ── 编码工具 ──────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 恒定时间比较，避免通过响应耗时逐字节猜出哈希。
 * 长度不同直接返回 false——这里的长度是固定的，不构成信息泄露。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── 哈希 ──────────────────────────────────────────────────────────

async function deriveKey(
  secret: string,
  salt: Uint8Array,
  pepper: string,
  iterations: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();

  // 第一层：HMAC-SHA256(pepper)。成本约 0.08ms，但让没有 pepper 的攻击者彻底无从下手。
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const peppered = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(secret)),
  );

  // 第二层：PBKDF2 拉长单次猜测成本
  const pbkdf2Key = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    pbkdf2Key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * 生成哈希。格式：`pbkdf2-sha256$<轮数>$<盐>$<哈希>`
 *
 * 轮数写进字符串里，将来想提高轮数时，老用户的哈希仍能正确校验。
 */
export async function hashSecret(
  secret: string,
  pepper: string,
  iterations: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(secret, salt, pepper, iterations);
  return [PBKDF2_HASH, iterations, bytesToBase64(salt), bytesToBase64(derived)].join('$');
}

export async function verifySecret(
  secret: string,
  stored: string,
  pepper: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_HASH) return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(parts[2]);
    expected = base64ToBytes(parts[3]);
  } catch {
    return false;
  }

  const actual = await deriveKey(secret, salt, pepper, iterations);
  return timingSafeEqual(actual, expected);
}

/** 密码哈希。轮数固定为 PASSWORD_ITERATIONS。 */
export function hashPassword(password: string, pepper: string): Promise<string> {
  return hashSecret(password, pepper, PASSWORD_ITERATIONS);
}

/** 房间级 PIN 哈希。轮数固定为 PIN_ITERATIONS。 */
export function hashPin(pin: string, pepper: string): Promise<string> {
  return hashSecret(pin, pepper, PIN_ITERATIONS);
}

/**
 * 常量时间占位哈希，用于「账号不存在」的分支。
 *
 * 不做这件事的话，邮箱未注册时接口会立刻返回 401，而邮箱已注册时要先跑一次
 * PBKDF2 再返回 401——PBKDF2 那一段的耗时就能区分出来了。这里对一个固定的
 * 假哈希跑一次真实的 PBKDF2，把这**一段**拉平。
 *
 * ⚠️ 但要说清楚它**没有**做到什么，否则很容易读成「账号是否存在是保密的」：
 *    PBKDF2 只是登录成功路径上的一小部分。成功路径还要
 *    `clearFailedAttempts`（UPDATE）、`createSession`（INSERT）、
 *    `buildSessionPayload`（若干 SELECT），而「账号不存在」路径一次写都没有。
 *    线上实测（2026-09）**墙钟中位数差 120ms**，40 次采样里成功组最小 386ms、
 *    失败组中位数 283ms——重复采样几次就能稳定区分。
 *
 *    也就是说：**邮箱是否注册过，在响应耗时上是可枚举的。**
 *    见 README「已知限制」。要真正堵住，只能在失败路径上也做一次等价的写，
 *    而那样等于给未认证请求开放 D1 写放大，得不偿失——所以选择如实记录，
 *    而不是留一句看起来在防、实际没防住的注释。
 *
 * **这不增加 CPU 峰值**：账号存在的那条路径本来就要跑一次。
 */
export async function dummyVerify(pepper: string): Promise<void> {
  const fakeHash = [
    PBKDF2_HASH,
    PASSWORD_ITERATIONS,
    bytesToBase64(new Uint8Array(SALT_BYTES)),
    bytesToBase64(new Uint8Array(32)),
  ].join('$');
  await verifySecret('dummy', fakeHash, pepper);
}

// ── 恢复码哈希 ────────────────────────────────────────────────────

/**
 * 恢复码哈希。
 *
 * 只做一次 SHA-256，不用 PBKDF2：码本身有约 40 bit 熵（8 位 × 31 种字符），
 * 不存在被爆破的可能，不需要拉长单次猜测成本，也就不触碰 10ms CPU 预算。
 * 这和会话令牌是同一个道理。
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return bytesToHex(new Uint8Array(digest));
}

// ── 会话令牌 ──────────────────────────────────────────────────────

/** 生成会话令牌原文。返回给用户的是它，数据库里存的是它的哈希。 */
export function newSessionToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

/**
 * 令牌哈希。
 *
 * 数据库里只存哈希，这样即使库被拖走，里面的值也不能直接当 cookie 用。
 * 令牌本身有 256 位熵，不存在被爆破的可能，所以用一次 SHA-256 就够，
 * 不需要 PBKDF2（也就不会触碰 10ms CPU 上限）。
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

// ── 会话存取 ──────────────────────────────────────────────────────

/**
 * 一次请求的登录态。
 *
 * `memberId` / `memberName` 可以为 null：账号已登录但当前房间下没有在住的
 * 成员档案（还没选房间，或已从该房间退租）。调用方必须处理这种情况，
 * 不能把它们当成一定存在的值。
 */
export interface SessionRecord {
  accountId: string;
  activeHouseholdId: string | null;
  memberId: string | null;
  memberName: string | null;
  passwordVerifiedAt: number | null;
}

/**
 * 按令牌查会话，并顺带推导出当前房间里的成员身份。
 *
 * ⚠️ 这个 LEFT JOIN 本身就是**授权检查**，不只是查询优化：
 *    members 只在 `account_id` 与 `household_id` 都匹配时才会被 join 上。
 *    任何人手工把 active_household_id 改成别人家的房间 id，都会 join 不出
 *    成员行，于是拿不到 memberId —— 后面自然 fail closed 返回 403，
 *    而不是把一个不属于他的身份交出去。
 *
 *    所以千万不要为了「查得快一点」把 member_id 冗余回 sessions 表。
 */
export async function lookupSession(
  db: D1Database,
  token: string,
): Promise<SessionRecord | null> {
  const tokenHash = await hashSessionToken(token);
  const row = await db
    .prepare(
      `SELECT s.account_id, s.active_household_id, s.expires_at, s.password_verified_at,
              m.id AS member_id, m.name AS member_name
         FROM sessions s
         LEFT JOIN members m
           ON m.account_id = s.account_id
          AND m.household_id = s.active_household_id
          AND m.is_active = 1
        WHERE s.token = ?`,
    )
    .bind(tokenHash)
    .first<{
      account_id: string;
      active_household_id: string | null;
      expires_at: number;
      password_verified_at: number | null;
      member_id: string | null;
      member_name: string | null;
    }>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
    return null;
  }

  return {
    accountId: row.account_id,
    activeHouseholdId: row.active_household_id,
    memberId: row.member_id,
    memberName: row.member_name,
    passwordVerifiedAt: row.password_verified_at,
  };
}

/**
 * 签发会话。
 *
 * `activeHouseholdId` 传 null 表示「已登录但还没选房间」——
 * 用户可能把唯一的房间退掉了，这时要引导他去建房或加入。
 */
export async function createSession(
  db: D1Database,
  accountId: string,
  activeHouseholdId: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const token = newSessionToken();
  const tokenHash = await hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare(
      `INSERT INTO sessions (token, account_id, active_household_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, accountId, activeHouseholdId, expiresAt, now)
    .run();

  // 顺手清理过期会话，避免表无限增长
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();

  return { token, expiresAt };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
}

/**
 * 撤销该账号除当前会话外的全部会话。改密码后调用。
 *
 * 这让「改密码」成为应对会话泄露的手段：即使某个令牌已经被别人拿到，
 * 改一次密码就能把它踢下线。
 */
export async function revokeOtherSessions(
  db: D1Database,
  accountId: string,
  keepToken: string,
): Promise<void> {
  const keepHash = await hashSessionToken(keepToken);
  await db
    .prepare('DELETE FROM sessions WHERE account_id = ? AND token <> ?')
    .bind(accountId, keepHash)
    .run();
}

// ── Cookie ────────────────────────────────────────────────────────

/**
 * 构造会话 cookie。
 *
 * HttpOnly   —— 挡 XSS 窃取令牌
 * SameSite=Lax —— 挡 CSRF（跨站发起的 POST 不会带上这个 cookie）
 * Secure     —— 只走 HTTPS
 * Path=/     —— 全站可用
 */
export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function buildLogoutCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

// ── 暴力破解限速 ──────────────────────────────────────────────────

/**
 * 允许做失败计数的表。表名会被拼进 SQL，因此必须限定取值。
 * accounts 用自己的主键 id，member_pins 的主键是 member_id。
 */
const LOCK_TARGETS = {
  accounts: 'id',
  member_pins: 'member_id',
} as const;

export type LockTarget = keyof typeof LOCK_TARGETS;

/**
 * 判断当前是否处于锁定期。
 *
 * 这是本方案**最关键的一环**：PIN 空间很小（4 位数字只有 1 万种组合），
 * 没有限速的话，任何人都能在几秒内穷举完所有 PIN，整套认证形同虚设。
 * 加盐哈希只防「数据库泄露后的离线爆破」，防不住在线穷举——只有限速能防。
 *
 * 密码也一样：邮箱+密码虽然空间大得多，但撞库（用别处泄露的密码试）是
 * 真实且低成本的攻击，同样需要限速。
 */
export function isLocked(row: { locked_until: number | null }): boolean {
  return row.locked_until !== null && row.locked_until > Date.now();
}

/** 剩余锁定秒数，用于提示用户。 */
export function lockRemainingSeconds(row: { locked_until: number | null }): number {
  if (!isLocked(row)) return 0;
  return Math.ceil((row.locked_until! - Date.now()) / 1000);
}

/** 登录失败：累加失败次数，达到阈值则锁定。 */
export async function recordFailedAttempt(
  db: D1Database,
  target: LockTarget,
  id: string,
): Promise<void> {
  const column = LOCK_TARGETS[target];
  const failed = await db
    .prepare(
      `UPDATE ${target} SET failed_tries = failed_tries + 1 WHERE ${column} = ? RETURNING failed_tries`,
    )
    .bind(id)
    .first<{ failed_tries: number }>();

  if (failed && failed.failed_tries >= MAX_FAILED_ATTEMPTS) {
    await db
      .prepare(`UPDATE ${target} SET failed_tries = 0, locked_until = ? WHERE ${column} = ?`)
      .bind(Date.now() + LOCK_DURATION_MS, id)
      .run();
  }
}

/** 登录成功：清空失败计数与锁定。 */
export async function clearFailedAttempts(
  db: D1Database,
  target: LockTarget,
  id: string,
): Promise<void> {
  const column = LOCK_TARGETS[target];
  await db
    .prepare(`UPDATE ${target} SET failed_tries = 0, locked_until = NULL WHERE ${column} = ?`)
    .bind(id)
    .run();
}

// ── PIN 格式校验 ──────────────────────────────────────────────────

export function validatePin(pin: unknown): string | null {
  if (typeof pin !== 'string') return 'PIN 必须是文本';
  if (pin.length < MIN_PIN_LENGTH) return `PIN 至少 ${MIN_PIN_LENGTH} 位`;
  if (pin.length > MAX_PIN_LENGTH) return `PIN 最多 ${MAX_PIN_LENGTH} 位`;
  if (pin.trim() !== pin) return 'PIN 首尾不能有空格';
  return null;
}
