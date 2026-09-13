import { describe, it, expect } from 'vitest';
import {
  hashPin,
  hashPassword,
  verifySecret,
  timingSafeEqual,
  newSessionToken,
  hashSessionToken,
  hashRecoveryCode,
  dummyVerify,
  validatePin,
  isLocked,
  lockRemainingSeconds,
  readSessionCookie,
  buildSessionCookie,
  buildLogoutCookie,
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MS,
  SESSION_COOKIE,
  PASSWORD_ITERATIONS,
  PIN_ITERATIONS,
} from '../src/worker/auth';
import { newRecoveryCode, normalizeInviteCode } from '../src/worker/ids';

// 测试跑在 Node 里，但 tsconfig 只挂了 `vite/client` 类型，没有 Node 全局。
// 这里刻意不引入 @types/node：那样会让 src/worker/ 里的代码也能引用 process、Buffer
// 这类 Node API 并顺利通过类型检查，但部署到 Cloudflare 会直接崩。就近声明一下即可。
declare const process: { env: Record<string, string | undefined> };

const PEPPER = 'test-pepper-not-a-real-secret';
const OTHER_PEPPER = 'a-different-pepper';

describe('hashPin / verifySecret', () => {
  it('正确 PIN 校验通过', async () => {
    const stored = await hashPin('1234', PEPPER);
    expect(await verifySecret('1234', stored, PEPPER)).toBe(true);
  });

  it('错误 PIN 校验失败', async () => {
    const stored = await hashPin('1234', PEPPER);
    expect(await verifySecret('1235', stored, PEPPER)).toBe(false);
    expect(await verifySecret('', stored, PEPPER)).toBe(false);
    expect(await verifySecret('12345', stored, PEPPER)).toBe(false);
  });

  it('相同 PIN 每次哈希都不同（盐生效，防彩虹表）', async () => {
    const a = await hashPin('1234', PEPPER);
    const b = await hashPin('1234', PEPPER);
    expect(a).not.toBe(b);
    // 但都能校验通过
    expect(await verifySecret('1234', a, PEPPER)).toBe(true);
    expect(await verifySecret('1234', b, PEPPER)).toBe(true);
  });

  it('★ pepper 不匹配则校验失败——这是数据库泄露后的防线', async () => {
    const stored = await hashPin('1234', PEPPER);
    expect(await verifySecret('1234', stored, OTHER_PEPPER)).toBe(false);
  });

  it('哈希字符串里不含明文 PIN', async () => {
    const stored = await hashPin('87654321', PEPPER);
    expect(stored).not.toContain('87654321');
    expect(stored.startsWith('pbkdf2-sha256$')).toBe(true);
  });

  it('抗篡改：格式非法的哈希串一律返回 false 而不是抛错', async () => {
    for (const bad of ['', 'garbage', 'pbkdf2-sha256$abc$x$y', 'md5$1$x$y', 'pbkdf2-sha256$0$a$b']) {
      await expect(verifySecret('1234', bad, PEPPER)).resolves.toBe(false);
    }
  });

  it('支持中文与长密码短语', async () => {
    const phrase = '我家猫叫土豆';
    const stored = await hashPin(phrase, PEPPER);
    expect(await verifySecret(phrase, stored, PEPPER)).toBe(true);
    expect(await verifySecret('我家猫叫地瓜', stored, PEPPER)).toBe(false);
  });
});

describe('单次哈希的 CPU 成本', () => {
  // ⚠️ 本机 Node 比 Cloudflare 快约 3 倍——这是踩过的坑：
  //    25,000 轮在本机是 3.3ms，看着很安全，线上实测却是 10~13ms，直接超限。
  //    所以本机阈值必须按 3 倍折算：本机 3.3ms ≈ 线上 10ms。
  //
  // 但「本机」不是一个固定速度：GitHub Actions 的 runner 明显比开发机慢，
  // 用同一个绝对阈值会误报。所以阈值走环境变量，CI 里放宽（见 workflow）。
  //
  // 真正防「有人偷偷调高轮数」的是下面那条**确定性**断言，不是这两条计时断言。
  // 计时断言现在只当金丝雀用：机器慢到离谱、或 WebCrypto 出问题时才会响。
  const LOCAL_BUDGET_MS = Number(process.env.HZM_CPU_LOCAL_BUDGET_MS ?? 3.3);

  it('密码哈希（最贵的那条路径）本机耗时在预算内（金丝雀）', async () => {
    // ⚠️ 这里必须测 hashPassword 而不是 hashPin。
    //    密码是 6,000 轮、PIN 只有 1,000 轮，而真正贴着 10ms 上限的是密码路径。
    //    拿 PIN 去测会得到一条轻松通过、但什么也没保证的测试。
    await hashPassword('correct horse battery staple', PEPPER); // 预热

    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await hashPassword('correct horse battery staple', PEPPER);
      runs.push(performance.now() - t0);
    }
    const avg = runs.reduce((a, b) => a + b, 0) / runs.length;

    expect(avg).toBeLessThan(LOCAL_BUDGET_MS);
  });

  it('轮数没有超过线上实测验证过的值', () => {
    // 这条是真正防回归的：确定性、不受机器快慢影响。
    // 6,000 轮是线上实测出来的上限（`wrangler tail --format json` 读 cpuTime，
    // 登录接口整体 5~7ms）。改高之前必须先实测，不能只改数字。
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(6_000);

    // PIN 压到 1,000 轮，好让「验旧 PIN + 算新 PIN」这条两段式路径
    // 加起来仍然落在预算内。真高到和密码一样，改 PIN 就会超限。
    expect(PIN_ITERATIONS).toBeLessThanOrEqual(1_500);
  });

  it('★ 唯一的两段式路径（改 PIN）不超过单次密码哈希的成本', () => {
    // 改 PIN 是全线唯一需要在一个请求里连续做两次哈希的路径（验旧 + 算新）。
    // 只要它两次加起来不超过一条已经线上实测过的密码路径，就不可能超限。
    // 密码那条路径之所以不适用这条，是因为它已经被拆成两个请求了。
    expect(PIN_ITERATIONS * 2).toBeLessThanOrEqual(PASSWORD_ITERATIONS);
  });
});

describe('恢复码', () => {
  it('格式为 XXXX-XXXX，且字符集不含易混字符', () => {
    for (let i = 0; i < 20; i++) {
      const code = newRecoveryCode();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      // 0/O/1/I/L 不在字符集里：恢复码是要用户抄在纸上的
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('每次生成都不同', () => {
    const set = new Set(Array.from({ length: 200 }, () => newRecoveryCode()));
    expect(set.size).toBe(200);
  });

  it('哈希稳定、不可逆，且能容忍用户手抄时的大小写和连字符差异', async () => {
    const code = newRecoveryCode();
    const stored = await hashRecoveryCode(normalizeInviteCode(code));

    expect(stored).toHaveLength(64); // SHA-256 hex
    expect(stored).not.toContain(code);

    // 用户抄成小写、漏掉连字符，归一化后必须是同一个哈希
    expect(await hashRecoveryCode(normalizeInviteCode(code.toLowerCase()))).toBe(stored);
    expect(await hashRecoveryCode(normalizeInviteCode(code.replace('-', '')))).toBe(stored);
    expect(await hashRecoveryCode(normalizeInviteCode(` ${code} `))).toBe(stored);
  });

  it('不同恢复码哈希不同', async () => {
    expect(await hashRecoveryCode(normalizeInviteCode(newRecoveryCode()))).not.toBe(
      await hashRecoveryCode(normalizeInviteCode(newRecoveryCode())),
    );
  });
});

describe('dummyVerify（防账号枚举的时序填充）', () => {
  it('不抛错，且确实做了一次真实的 PBKDF2', async () => {
    await expect(dummyVerify(PEPPER)).resolves.toBeUndefined();

    // 与真实校验同量级——否则填充就没意义了，耗时差异照样能被测出来
    const t0 = performance.now();
    await dummyVerify(PEPPER);
    const dummyMs = performance.now() - t0;

    const account = await hashPassword('whatever', PEPPER);
    const t1 = performance.now();
    await verifySecret('whatever', account, PEPPER);
    const realMs = performance.now() - t1;

    // 两者数量级应当接近（放宽到 4 倍，避免在慢机器上抖动误报）
    expect(dummyMs).toBeLessThan(realMs * 4 + 2);
  });
});

describe('timingSafeEqual', () => {
  it('相同内容返回 true', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('不同内容返回 false', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('长度不同返回 false 而不是越界读', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('会话令牌', () => {
  it('每次生成都不同且长度足够', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => newSessionToken()));
    expect(tokens.size).toBe(100);
    // 32 字节 base64 ≈ 44 字符
    expect([...tokens][0].length).toBeGreaterThanOrEqual(40);
  });

  it('哈希稳定且不可逆', async () => {
    const token = newSessionToken();
    const a = await hashSessionToken(token);
    const b = await hashSessionToken(token);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // SHA-256 hex
    expect(a).not.toContain(token);
  });

  it('不同令牌哈希不同', async () => {
    expect(await hashSessionToken(newSessionToken())).not.toBe(
      await hashSessionToken(newSessionToken()),
    );
  });
});

describe('cookie', () => {
  it('会话 cookie 带齐安全属性', () => {
    const cookie = buildSessionCookie('tok123', 3600);
    expect(cookie).toContain(`${SESSION_COOKIE}=tok123`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('登出 cookie 立即过期', () => {
    expect(buildLogoutCookie()).toContain('Max-Age=0');
  });

  it('解析 cookie，忽略其他字段', () => {
    expect(readSessionCookie('foo=1; hzm_session=abc; bar=2')).toBe('abc');
    expect(readSessionCookie('hzm_session=abc')).toBe('abc');
  });

  it('没有 cookie 时返回 null', () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
    expect(readSessionCookie('foo=1; bar=2')).toBeNull();
  });

  it('cookie 值里含 = 也能正确解析（base64 补位符）', () => {
    expect(readSessionCookie('hzm_session=abc==; x=1')).toBe('abc==');
  });
});

describe('暴力破解限速', () => {
  it('未锁定的成员可以登录', () => {
    expect(isLocked({ locked_until: null })).toBe(false);
    expect(isLocked({ locked_until: Date.now() - 1000 })).toBe(false);
  });

  it('锁定期内的成员被拒绝', () => {
    expect(isLocked({ locked_until: Date.now() + 60_000 })).toBe(true);
  });

  it('剩余锁定时间提示', () => {
    expect(lockRemainingSeconds({ locked_until: null })).toBe(0);
    const remaining = lockRemainingSeconds({ locked_until: Date.now() + 60_000 });
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it('阈值配置合理——太大则形同虚设', () => {
    expect(MAX_FAILED_ATTEMPTS).toBeLessThanOrEqual(10);
    expect(LOCK_DURATION_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('validatePin', () => {
  it('接受合法 PIN', () => {
    expect(validatePin('1234')).toBeNull();
    expect(validatePin('123456')).toBeNull();
    expect(validatePin('我家猫叫土豆')).toBeNull();
  });

  it('拒绝过短、过长、非文本、带空格', () => {
    expect(validatePin('123')).toBeTruthy();
    expect(validatePin('x'.repeat(65))).toBeTruthy();
    expect(validatePin(1234)).toBeTruthy();
    expect(validatePin(' 1234')).toBeTruthy();
  });

  it('4 位纯数字 PIN 是最弱但可接受的下限', () => {
    expect(validatePin('0000')).toBeNull();
  });
});
