/**
 * 第二期（账号体系 + 多房间）本地端到端验证。
 *
 *   npm run dev                      # 另开一个终端
 *   node scripts/e2e-phase2.mjs
 *
 * 为什么用 Node 而不是 bash+curl：Windows 上 Git Bash 会在管道里把 UTF-8 的
 * 中文拧成乱码，而本项目大量断言涉及中文（房间名、成员名、错误文案）。
 * Node 从头到尾按 UTF-8 处理，`JSON.stringify` 直接产出正确的字节，
 * `fetch` 原样发出去——这一整类问题就不存在了。
 *
 * ⚠️ 会往本地 D1 写数据。重跑前重置：
 *      rm -rf .wrangler/state/v3/d1 && npm run db:local
 *
 * 每节用独立的 cookie jar，且**篡改数据库的那一节放在最后**并单独用一次性账号，
 * 避免污染后续断言。（bash 版就是栽在这里：第 7 节改了 A 的会话，
 * 后面 5 节的结论全部作废。）
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.HZM_BASE ?? 'http://localhost:5173/api';

/**
 * 这套测试既可以打本地 dev server，也可以打线上：
 *
 *   node scripts/e2e-phase2.mjs
 *   HZM_BASE=https://<你的域名>/api node scripts/e2e-phase2.mjs
 *
 * ⚠️ 第 12 节要直接改库。改库那条命令的目标必须跟着 BASE 走——
 *    写死 `--local` 的话，打线上时 UPDATE 落在了本地库上，
 *    那一节在线上**什么都没验证**，却会全绿通过。
 */
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(BASE);
const DB_FLAG = IS_LOCAL ? '--local' : '--remote';

let pass = 0;
const failures = [];

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function ok(msg) {
  pass++;
  console.log(`  ${C.g}PASS${C.x} ${msg}`);
}
function bad(msg, want, got) {
  failures.push(msg);
  console.log(`  ${C.r}FAIL${C.x} ${msg}`);
  console.log(`       ${C.d}期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}${C.x}`);
}
function eq(msg, want, got) {
  // 用 Object.is 之外还要处理数字/字符串：这里刻意严格比较，
  // 想让 5000 和 "5000" 算不同——接口返回的类型本身就该被断言。
  if (want === got) ok(msg);
  else bad(msg, want, got);
}
function section(t) {
  console.log(`\n${C.b}${t}${C.x}`);
}

// ── 带 cookie 的请求 ───────────────────────────────────────────────

class Jar {
  cookie = null;
  async req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const sc of setCookies) {
      const m = /^hzm_session=([^;]*)/.exec(sc);
      if (m) this.cookie = `hzm_session=${m[1]}`;
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, body: json, raw: text };
  }
  get = (p) => this.req('GET', p);
  post = (p, b) => this.req('POST', p, b ?? {});
  patch = (p, b) => this.req('PATCH', p, b ?? {});
  del = (p) => this.req('DELETE', p);
}

/**
 * 拿一个 .sql 文件去打数据库（第 12 节用）。
 *
 * 直接用 node 跑 wrangler 的入口脚本，而不是 `npx` / `npx.cmd`：
 * Node 24 起在 Windows 上禁止 spawnSync 直接执行 .cmd（抛 EINVAL），
 * 而 `shell: true` 会把参数拼成字符串（既有注入面，又有一条 DeprecationWarning）。
 */
function runSqlFile(file) {
  execFileSync(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'hezu-db', DB_FLAG, `--file=${file}`],
    { stdio: 'pipe' },
  );
}

const PW = 'correct-horse-1';
const stamp = Date.now();
const A_MAIL = `a${stamp}@example.com`;
const B_MAIL = `b${stamp}@example.com`;

// ── 1. 注册 ───────────────────────────────────────────────────────
section('1. 邮箱注册');
const A = new Jar();

{
  const r = await A.post('/auth/register', { email: A_MAIL, password: PW });
  eq('注册返回 201', 201, r.status);
  eq('注册后还没有房间', null, r.body.household);
  eq('注册后 households 为空', 0, r.body.households?.length ?? -1);
  eq('注册返回 8 个恢复码', 8, r.body.recoveryCodes?.length ?? -1);
  const c0 = r.body.recoveryCodes?.[0] ?? '';
  ok(`恢复码格式 ${/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c0) ? '正确' : '错误：' + c0}`);
  A.code1 = c0;
}

{
  const r = await A.post('/auth/register', { email: A_MAIL, password: PW });
  eq('同邮箱重复注册 409', 409, r.status);
  eq('重复注册的 code 是 EMAIL_TAKEN', 'EMAIL_TAKEN', r.body.code);
}

{
  const r = await A.post('/auth/register', { email: 'not-an-email', password: PW });
  eq('非法邮箱被拒', 400, r.status);
}
{
  const r = await A.post('/auth/register', { email: `x${stamp}@example.com`, password: 'short' });
  eq('密码过短被拒', 400, r.status);
}

// ── 2. 建第一个房间 ───────────────────────────────────────────────
section('2. 建第一个房间');
let H1, M1, INVITE1;
{
  const r = await A.post('/auth/household', {
    householdName: '望京 502',
    memberName: '小明',
    room: '主卧',
  });
  eq('建房返回 201', 201, r.status);
  H1 = r.body.household?.id;
  M1 = r.body.member?.id;
  INVITE1 = r.body.household?.inviteCode;
  ok(`拿到房间 id 与邀请码 ${INVITE1}`);
  eq('房间名正确（中文没坏）', '望京 502', r.body.household?.name);
  eq('成员名正确（中文没坏）', '小明', r.body.member?.name);
  eq('房间号正确', '主卧', r.body.member?.room);
  eq('households 列表有 1 项', 1, r.body.households?.length);
}

{
  const r = await A.get('/auth/me');
  eq('/auth/me 当前房间', H1, r.body.household?.id);
  eq('/auth/me 当前身份', M1, r.body.member?.id);
  eq('/auth/me 账号邮箱', A_MAIL, r.body.account?.email);
  eq('/auth/me emailVerified 为 false', false, r.body.account?.emailVerified);
}

// ── 3. B 用邀请码加入 ─────────────────────────────────────────────
section('3. 第二个账号用邀请码加入');
const B = new Jar();
let M2;
{
  const r = await B.post('/auth/register', { email: B_MAIL, password: PW });
  eq('B 注册成功', 201, r.status);
}
{
  const r = await B.get(`/auth/household/${INVITE1}`);
  eq('邀请码查询 200', 200, r.status);
  eq('查询返回房间名', '望京 502', r.body.household?.name);
  eq('小明已被认领', true, r.body.members?.find((m) => m.name === '小明')?.claimed);
  eq('查询接口不泄露 PIN 是否存在', undefined, r.body.members?.[0]?.hasPin);
}
{
  const r = await B.get('/auth/household/NOPE-NOPE');
  eq('无效邀请码 404', 404, r.status);
}
{
  const r = await B.post('/auth/join', { inviteCode: INVITE1, name: '小红', room: '次卧' });
  eq('B 加入返回 201', 201, r.status);
  M2 = r.body.member?.id;
  eq('B 落在同一个房间', H1, r.body.household?.id);
  eq('B 的名字', '小红', r.body.member?.name);
  ok(`两个账号是不同成员：${M1 !== M2}`);
}
const C2 = new Jar();
{
  // 同名再加一次：应该认领/拒绝，而不是凭空造出第二个「小红」
  await C2.post('/auth/register', { email: `c${stamp}@example.com`, password: PW });
  const r = await C2.post('/auth/join', { inviteCode: INVITE1, name: '小红' });
  eq('别人不能再用已被占用的名字加入', 409, r.status);
  eq('返回 CLAIMED_ALREADY', 'CLAIMED_ALREADY', r.body.code);
  eq('并给出可操作的提示', true, /小红/.test(r.body.error ?? ''));
}
{
  // 换个能区分的名字就该放行——真实世界里确实有同名的人，
  // 不能因为同名就永久挡住新室友。
  const r = await C2.post('/auth/join', { inviteCode: INVITE1, name: '小红 A' });
  eq('换个区分度高的名字可以加入', 201, r.status);
}
{
  // 匿名加入失败时不该留下半个账号：账号建了、成员没建、用户以为没成功，
  // 下次再用同一个邮箱注册会撞 EMAIL_TAKEN，而且他不知道密码其实已经生效了。
  //
  // ⚠️ 必须用全新邮箱走**匿名**路径。上面那个 C2 已经有会话了，
  //    createdAccountId 是 null，回滚是空操作——那样测出来的是错觉。
  const C3 = new Jar();
  const C3_MAIL = `c3${stamp}@example.com`;
  const r = await C3.post('/auth/join', {
    inviteCode: INVITE1,
    name: '小红',
    email: C3_MAIL,
    password: PW,
  });
  eq('匿名加入撞上已占用的名字 → 409', 409, r.status);

  const r2 = await C3.post('/auth/register', { email: C3_MAIL, password: PW });
  eq('失败的匿名加入回滚掉了刚建的账号', 201, r2.status);
}

// ── 4. 记账与余额 ─────────────────────────────────────────────────
section('4. 记一笔账（100.00 元，两人均摊）');
{
  const r = await A.post('/expenses', {
    title: '保洁费',
    amount: 10000,
    category: '其他',
    paidBy: M1,
    splitType: 'equal',
    memberIds: [M1, M2],
  });
  eq('记账返回 201', 201, r.status);
  eq('账目名中文正确', '保洁费', r.body.expense?.title);
}
{
  const r = await A.get('/balance');
  eq('我的余额 +5000', 5000, r.body.balances.find((b) => b.memberId === M1)?.amount);
  eq('小红余额 -5000', -5000, r.body.balances.find((b) => b.memberId === M2)?.amount);
  eq(
    '余额总和为 0（硬不变量）',
    0,
    r.body.balances.reduce((a, b) => a + b.amount, 0),
  );
}
{
  // 跨房间分摊：B 在另一个房间有身份，不能被塞进这个房间的账目
  const r = await A.post('/expenses', {
    title: '跨房间试探',
    amount: 100,
    category: '其他',
    paidBy: M1,
    splitType: 'equal',
    memberIds: ['not-a-member-of-this-household'],
  });
  eq('分摊给房间外的成员被拒', 400, r.status);
}

// ── 5. 第二个房间 ─────────────────────────────────────────────────
section('5. 同一账号开第二个房间');
let H2, M3;
{
  const r = await A.post('/auth/household', { householdName: '酒仙桥 3 号楼', memberName: '明哥' });
  eq('开第二个房间返回 201', 201, r.status);
  H2 = r.body.household?.id;
  M3 = r.body.member?.id;
  ok(`两个房间 id 不同：${H1 !== H2}`);
  eq('第二间房里的名字是明哥', '明哥', r.body.member?.name);
  eq('households 列表有 2 项', 2, r.body.households?.length);
  // 前端顶栏的「＋ 房间」弹窗依赖这一条：已登录时建房，服务端会顺带把会话的
  // active_household_id 切到新房间（auth.ts:541）。不切的话弹窗提交完会
  // 停在原地、看起来像没成功。（见 HouseholdForms.tsx 顶部注释。）
  eq('开完新房，当前房间就是新房', H2, r.body.household?.id);
  eq('老账号开新房不发恢复码', undefined, r.body.recoveryCodes);
  ok(`两个房间的身份不同：${M1 !== M3}`);
}
{
  const r = await A.get('/balance');
  eq('第二间房余额总和为 0', 0, r.body.balances.reduce((a, b) => a + b.amount, 0));
  eq('第二间房只有一个成员', 1, r.body.balances.length);
}
{
  const r = await A.get('/expenses');
  eq('第二间房的账目是空的', 0, r.body.total);
}

// ── 6. 切回第一个房间 ─────────────────────────────────────────────
section('6. 切回第一个房间，确认账目没串也没丢');
{
  const r = await A.post('/auth/switch', { householdId: H1 });
  eq('切房返回 200', 200, r.status);
  eq('切房后身份回到小明', M1, r.body.member?.id);
  eq('切房后房间是 H1', H1, r.body.household?.id);
  eq('households 列表仍有 2 项（切房不改成员关系）', 2, r.body.households?.length);
}
{
  const r = await A.get('/balance');
  eq('切回后我的余额仍是 +5000', 5000, r.body.balances.find((b) => b.memberId === M1)?.amount);
  eq(
    '切回后余额总和仍为 0',
    0,
    r.body.balances.reduce((a, b) => a + b.amount, 0),
  );
}
{
  const r = await A.get('/expenses');
  eq('切回后账目仍在', 1, r.body.total);
}

// ── 7. 越权（不碰库的那一层）─────────────────────────────────────
section('7. 越权：切到自己没加入的房间');
let H3;
{
  const r = await B.post('/auth/household', { householdName: '别人的房间', memberName: '路人' });
  H3 = r.body.household?.id;
  eq('B 建了第三个房间', 201, r.status);
}
{
  const r = await A.post('/auth/switch', { householdId: H3 });
  eq('A 切进 H3 被拒 403', 403, r.status);
}
{
  const r = await A.post('/auth/switch', { householdId: 'no-such-household' });
  eq('切到不存在的房间被拒 403', 403, r.status);
}

// ── 8. 改密码的两段式 ─────────────────────────────────────────────
section('8. 改密码必须分两步（每步恰好一次 PBKDF2）');
{
  const r = await A.post('/auth/password', { newPassword: 'brand-new-pass-1' });
  eq('没先验旧密码就想改 → 403', 403, r.status);
}
{
  const r = await A.post('/auth/password/verify', { password: 'wrong-one' });
  eq('旧密码错 → 401', 401, r.status);
  eq('旧密码错返回 INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', r.body.code);
}
{
  const r = await A.post('/auth/password/verify', { password: PW });
  eq('验旧密码通过 200', 200, r.status);
  eq('返回有效期', true, typeof r.body.expiresInMs === 'number' && r.body.expiresInMs > 0);
}
{
  const r = await A.post('/auth/password', { newPassword: 'brand-new-pass-1' });
  eq('改密码成功 200', 200, r.status);
}
{
  const r = await B.get('/balance');
  eq('B 的会话不受影响（只撤销本账号其它会话）', 200, r.status);
}
{
  const r = await A.post('/auth/login', { email: A_MAIL, password: PW });
  eq('旧密码已失效 401', 401, r.status);
}
{
  const r = await A.post('/auth/login', { email: A_MAIL, password: 'brand-new-pass-1' });
  eq('新密码可登录 200', 200, r.status);
  // 登录会自动落到「最近加入的在住房间」——A 加入过 H1 然后 H2，所以是 H2
  eq('登录后自动落到最近加入的房间 H2', H2, r.body.household?.id);
}
{
  const r = await A.get('/auth/me');
  eq('新会话带着房间，不用再选一次', H2, r.body.household?.id);
}

// ── 9. 恢复码 ─────────────────────────────────────────────────────
section('9. 用恢复码找回密码');
{
  const r = await A.post('/auth/recovery', {
    email: A_MAIL,
    code: 'ZZZZ-ZZZZ',
    newPassword: 'hijacked-pass-1',
  });
  eq('错误恢复码 → 401', 401, r.status);
}
{
  const r = await A.post('/auth/recovery', {
    email: A_MAIL,
    code: A.code1,
    newPassword: 'recovered-pass-1',
  });
  eq('正确恢复码 → 200', 200, r.status);
}
{
  const r = await A.post('/auth/recovery', {
    email: A_MAIL,
    code: A.code1,
    newPassword: 'second-use-pass-1',
  });
  eq('同一恢复码不能用第二次', 401, r.status);
}
{
  const r = await A.post('/auth/login', { email: A_MAIL, password: 'recovered-pass-1' });
  eq('重置后的新密码可登录', 200, r.status);
}

// ── 10. PIN ───────────────────────────────────────────────────────
section('10. PIN（房间级快捷登录）');
{
  // A 此刻在 H2，身份是明哥。PIN 就该设在这个身份上。
  const r = await A.post('/auth/pin', { pin: '2468' });
  eq('首次设 PIN 不需要旧 PIN', 200, r.status);
}
{
  const r = await A.post('/auth/pin', { pin: '1357' });
  // 400 而不是 401：这是「少传了必填字段」，不是「凭证不对」。
  // 区分开有个实际好处——401 在前端会触发会话失效的分支逻辑。
  eq('已有 PIN 时不带 currentPin → 400', 400, r.status);
}
{
  const r = await A.post('/auth/pin', { pin: '1357', currentPin: '2468' });
  eq('带上正确的 currentPin → 200', 200, r.status);
}
{
  const r = await A.post('/auth/pin', { pin: '1' });
  eq('过短的 PIN 被拒', 400, r.status);
}
{
  const r = await A.post('/auth/logout');
  eq('退出登录 200', 200, r.status);
  const me = await A.get('/auth/me');
  eq('退出后 /auth/me 401', 401, me.status);
}
{
  const INVITE2 = (await A.post('/auth/login', { email: A_MAIL, password: 'recovered-pass-1' })).body
    .household?.inviteCode;
  const r = await A.post('/auth/login/pin', { inviteCode: INVITE2, memberId: M3, pin: '0000' });
  eq('PIN 错误 → 401', 401, r.status);
}
{
  const s = await A.post('/auth/login', { email: A_MAIL, password: 'recovered-pass-1' });
  const INVITE2 = s.body.household?.inviteCode;
  const r = await A.post('/auth/login/pin', { inviteCode: INVITE2, memberId: M3, pin: '1357' });
  eq('PIN 正确 → 200', 200, r.status);
  eq('PIN 登录后身份是明哥', M3, r.body.member?.id);
  eq('PIN 登录后落在 H2', H2, r.body.household?.id);
}
{
  // 小明（H1）从没设过 PIN，应该被明确告知去用邮箱密码，而不是含糊地失败
  const r = await A.post('/auth/login/pin', { inviteCode: INVITE1, memberId: M1, pin: '1357' });
  eq('没设过 PIN 的身份 → 400', 400, r.status);
  eq('并给出可操作的提示', true, /邮箱密码/.test(r.body.error ?? ''));
}

// ── 11. 退租后能自救 ─────────────────────────────────────────────
section('11. 退租后回到「选房间」页，而不是登录页');
{
  const r = await B.post('/auth/switch', { householdId: H1 });
  eq('先把 B 切回 H1', 200, r.status);
}
{
  const r = await B.post(`/members/${M2}/leave`);
  eq('B 退租 200', 200, r.status);
}
{
  const r = await B.get('/auth/me');
  eq('退租后 /auth/me 仍是 200（登录态还在）', 200, r.status);
  eq('退租后 household 为 null', null, r.body.household);
  eq('退租后 member 为 null', null, r.body.member);
  eq('households 里 H1 消失了（只剩自己建的 H3）', 1, r.body.households?.length);
}
{
  const r = await B.get('/balance');
  eq('退租后查余额 403', 403, r.status);
  eq('且是 NO_MEMBERSHIP 而不是 SESSION_EXPIRED', 'NO_MEMBERSHIP', r.body.code);
}
{
  const r = await B.post('/auth/join', { inviteCode: INVITE1, name: '小红' });
  eq('退租后能自己重新加入（不用换账号）', 200, r.status);
  // ★ 这条是整个套件里最容易写成「看起来通过」的一条。
  //   如果实现是新建一条成员档案，下面「余额 -5000」也会通过——
  //   因为退租者仍参与计算，-5000 还挂在旧行上。只有断言 members.id
  //   不变，才能真正区分「接上了历史」和「负债凭空消失」。
  eq('重新加入时沿用原档案，不新建身份', M2, r.body.member?.id);
  eq('重新加入后身份是活跃的', M2, r.body.household && r.body.member?.id);
}
{
  const r = await B.get('/balance');
  eq('重新加入后余额还是 -5000', -5000, r.body.balances.find((b) => b.memberId === M2)?.amount);
  eq('且这个身份是活跃的（不是一条孤零零的退租记录）', true, r.body.balances.find((b) => b.memberId === M2)?.isActive);
  // 按名字数而不是按总数：套件里有别的测试账号也在 H1，数总数会误报。
  // 真正要守的不变量是「活跃的小红恰好一个」。
  eq('活跃的「小红」恰好一个', 1, r.body.balances.filter((b) => b.name === '小红' && b.isActive).length);
}

// ── 12. 篡改数据库（最后一节，用一次性账号，不污染前面的状态）─────
section('12. 越权：直接改库绕过路由校验（fail closed）');
{
  const D = new Jar();
  const D_MAIL = `d${stamp}@example.com`;
  await D.post('/auth/register', { email: D_MAIL, password: PW });
  const own = await D.post('/auth/household', { householdName: 'D 的房间', memberName: 'D' });
  eq('D 建房成功', 201, own.status);
  const ownHouseholdId = own.body.household?.id;

  // 把 D 的会话指向 H1——D 不是 H1 的成员。
  // 路由层的校验被完全绕过，只剩 requireAuth 的 LEFT JOIN 兜底。
  //
  // 走 --file 而不是 --command：SQL 里有空格和括号，交给 shell 传参会被拆成
  // 一堆「未知参数」。临时文件顺带把引号问题整个消掉。
  const sqlFile = join(tmpdir(), `hzm-tamper-${Date.now()}.sql`);
  const restoreFile = join(tmpdir(), `hzm-restore-${Date.now()}.sql`);
  writeFileSync(
    sqlFile,
    `UPDATE sessions SET active_household_id='${H1}'\n WHERE account_id=(SELECT id FROM accounts WHERE email='${D_MAIL}');\n`,
  );
  // 测试要自己收尾：篡改完不还原的话，这条会话会永远指向一个自己不在的房间，
  // 于是 `npm run db:verify` 的 `session without membership` 会一直非零，
  // 把真正的信号淹掉。
  writeFileSync(
    restoreFile,
    `UPDATE sessions SET active_household_id='${ownHouseholdId}'\n WHERE account_id=(SELECT id FROM accounts WHERE email='${D_MAIL}');\n`,
  );
  try {
    runSqlFile(sqlFile);
    try {
      const r = await D.get('/balance');
      eq('库被篡改后业务接口 403', 403, r.status);
      eq('返回 NO_MEMBERSHIP', 'NO_MEMBERSHIP', r.body.code);

      const me = await D.get('/auth/me');
      eq('被篡改后 /auth/me 仍是 200（不是登录失效）', 200, me.status);
      eq('/me 里 household 降级为 null', null, me.body.household);
      eq('/me 里 households 仍列出自己真正在的房间', 1, me.body.households?.length);
      eq('那条被篡改的会话没泄露 H1 的任何信息', 'D 的房间', me.body.households?.[0]?.name);

      const exp = await D.get('/expenses');
      eq('账目接口同样 403，拿不到 H1 的数据', 403, exp.status);

      const sw = await D.post('/auth/switch', { householdId: H1 });
      eq('且无法借此把自己合法化', 403, sw.status);
    } finally {
      runSqlFile(restoreFile);
    }
  } finally {
    rmSync(sqlFile, { force: true });
    rmSync(restoreFile, { force: true });
  }

  // 收尾之后应该能正常用了——顺带证明还原确实生效，
  // 而不是「403 了所以看起来对」。
  const after = await D.get('/balance');
  eq('还原后 D 又能正常访问自己的房间', 200, after.status);
}

// ── 总结 ──────────────────────────────────────────────────────────
console.log(`\n${C.b}────────────────────────────────${C.x}`);
if (failures.length === 0) {
  console.log(`${C.g}全部通过：${pass} 项${C.x}`);
  process.exit(0);
}
console.log(`${C.r}${failures.length} 项失败${C.x}，${pass} 项通过`);
for (const f of failures) console.log(`  ${C.r}·${C.x} ${f}`);
process.exit(1);
