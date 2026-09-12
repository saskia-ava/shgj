/**
 * 认证：PIN 哈希、会话签发与校验、暴力破解限速。
 *
 * ⚠️ Workers 免费版每个请求只有 10ms CPU 时间，超了会被掐断（Error 1102）。
 *
 * 轮数是在线上实测出来的，不是照着推荐值抄的。踩过的坑：
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
 * 关于 4 位 PIN：就算按 OWASP 推荐值上 600,000 轮，1 万种组合也只要 30 分钟就能穷举完，
 * 轮数救不了短 PIN。真正拦住猜 PIN 的是登录失败锁定（5 次锁 15 分钟）——那是硬约束，
 * 因为它在服务端累加，绕不过去。想更安全请用长密码短语，界面里已经这么引导了。
 *
 * 改动轮数不会让老哈希失效：轮数写在哈希串里，校验时从串里读。
 */

const PBKDF2_ITERATIONS = 6_000;
const PBKDF2_HASH = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;

export const SESSION_COOKIE = 'hzm_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 连续失败多少次后锁定 */
export const MAX_FAILED_ATTEMPTS = 5;
/** 锁定时长 */
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** PIN 最短长度。允许任意字符，方便用户改用更长的密码短语。 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 64;

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

// ── PIN 哈希 ──────────────────────────────────────────────────────

async function deriveKey(
  pin: string,
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
    await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(pin)),
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
 * 生成 PIN 哈希。格式：`pbkdf2-sha256$<轮数>$<盐>$<哈希>`
 *
 * 轮数写进字符串里，将来想提高轮数时，老用户的哈希仍能正确校验，
 * 可以在他们下次登录成功时静默重算升级。
 */
export async function hashPin(pin: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(pin, salt, pepper, PBKDF2_ITERATIONS);
  return [PBKDF2_HASH, PBKDF2_ITERATIONS, bytesToBase64(salt), bytesToBase64(derived)].join('$');
}

export async function verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
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

  const actual = await deriveKey(pin, salt, pepper, iterations);
  return timingSafeEqual(actual, expected);
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

export interface SessionRecord {
  memberId: string;
  householdId: string;
  memberName: string;
}

export async function createSession(
  db: D1Database,
  householdId: string,
  memberId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = newSessionToken();
  const tokenHash = await hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare('INSERT INTO sessions (token, member_id, household_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, memberId, householdId, expiresAt, now)
    .run();

  // 顺手清理过期会话，避免表无限增长
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();

  return { token, expiresAt };
}

export async function lookupSession(db: D1Database, token: string): Promise<SessionRecord | null> {
  const tokenHash = await hashSessionToken(token);
  const row = await db
    .prepare(
      `SELECT s.member_id, s.household_id, s.expires_at, m.name
         FROM sessions s
         JOIN members m ON m.id = s.member_id
        WHERE s.token = ?`,
    )
    .bind(tokenHash)
    .first<{ member_id: string; household_id: string; expires_at: number; name: string }>();

  if (!row) return null;

  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
    return null;
  }

  return { memberId: row.member_id, householdId: row.household_id, memberName: row.name };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
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
 * 判断成员当前是否处于锁定期。
 *
 * 这是本方案**最关键的一环**：PIN 空间很小（4 位数字只有 1 万种组合），
 * 没有限速的话，任何人都能在几秒内穷举完所有 PIN，整套认证形同虚设。
 * 加盐哈希只防「数据库泄露后的离线爆破」，防不住在线穷举——只有限速能防。
 */
export function isLocked(member: { locked_until: number | null }): boolean {
  return member.locked_until !== null && member.locked_until > Date.now();
}

/** 剩余锁定秒数，用于提示用户。 */
export function lockRemainingSeconds(member: { locked_until: number | null }): number {
  if (!isLocked(member)) return 0;
  return Math.ceil((member.locked_until! - Date.now()) / 1000);
}

/** 登录失败：累加失败次数，达到阈值则锁定。 */
export async function recordFailedAttempt(db: D1Database, memberId: string): Promise<void> {
  const failed = await db
    .prepare('UPDATE members SET failed_tries = failed_tries + 1 WHERE id = ? RETURNING failed_tries')
    .bind(memberId)
    .first<{ failed_tries: number }>();

  if (failed && failed.failed_tries >= MAX_FAILED_ATTEMPTS) {
    await db
      .prepare('UPDATE members SET failed_tries = 0, locked_until = ? WHERE id = ?')
      .bind(Date.now() + LOCK_DURATION_MS, memberId)
      .run();
  }
}

/** 登录成功：清空失败计数与锁定。 */
export async function clearFailedAttempts(db: D1Database, memberId: string): Promise<void> {
  await db
    .prepare('UPDATE members SET failed_tries = 0, locked_until = NULL WHERE id = ?')
    .bind(memberId)
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
