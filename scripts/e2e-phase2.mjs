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
 * ⚠️ 第 13 节要直接改库。改库那条命令的目标必须跟着 BASE 走——
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
 * 拿一个 .sql 文件去打数据库（第 13 节用）。
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

// ── 12. 头像 ──────────────────────────────────────────────────────
//
// 用一次性账号，理由和下面那节一样：不依赖前面各节留下的会话状态。
// 第 9 节用恢复码重置密码会**清空所有登录态**，第 11 节又把 B 退租又重新加入，
// 想在这里复用 A / B 得先把这些副作用全推一遍——很脆，而且一旦哪节改了顺序
// 这里会跟着坏，且坏得很难看出来。
section('12. 头像：只能换自己的');
{
  const E = new Jar();
  const eMail = `avatar${stamp}@example.com`;

  const reg = await E.post('/auth/register', { email: eMail, password: PW });
  eq('注册 201', 201, reg.status);
  const made = await E.post('/auth/household', { householdName: '头像测试房', memberName: '阿头' });
  eq('建房 201', 201, made.status);
  const meId = made.body.member?.id;
  eq('新账号默认没有头像（用首字母兜底）', null, made.body.member?.avatar);

  // 加一个「别人」当越权测试的靶子。
  //
  // ⚠️ 这里**不要**写成 `ok(\`建好了 ${id ? '✓' : '✗'}\`)`——那个 ok() 是
  //    无条件的，字符串里写「✗ 没找到」它照样报 PASS。第一版就是这么写的，
  //    于是靶子根本没建出来，后面两条越权断言拿 undefined 去打 404，
  //    还显示成「一条通过一条失败」，而真正的原因在最上面那一行绿字里。
  //    凡是能被写成 eq 的，就不要用 ok 加三元表达式。
  const other = await E.post('/members', { name: '别人' });
  eq('占位成员创建 201', 201, other.status);
  const otherId = other.body.member?.id;
  eq('新成员默认没有头像', null, other.body.member?.avatar);

  // 1) 换自己的
  const set = await E.patch(`/members/${meId}`, { avatar: 'fox' });
  eq('换自己的头像 200', 200, set.status);
  const me1 = await E.get('/auth/me');
  eq('/me 里读回新头像', 'fox', me1.body.member?.avatar);
  eq('households 列表里也带头像', 'fox', me1.body.households?.find((h) => h.id === made.body.household?.id)?.avatar);

  // 2) 不在白名单里的值必须被拒，且**不能**把已有的改坏
  const badValue = await E.patch(`/members/${meId}`, { avatar: 'not-a-real-avatar' });
  eq('不在白名单里的值被拒 400', 400, badValue.status);
  const me2 = await E.get('/auth/me');
  eq('被拒之后头像没有变', 'fox', me2.body.member?.avatar);

  // 3) 换别人的——本节真正要守的一条
  const cross = await E.patch(`/members/${otherId}`, { avatar: 'tiger' });
  eq('换别人的头像 403', 403, cross.status);
  const list1 = await E.get('/members');
  eq('别人的头像仍然是空的', null, list1.body.members?.find((m) => m.id === otherId)?.avatar);

  // 4) GET /members 本身。
  //
  // ⚠️ 这一节是**唯一**碰 GET /members 的地方，而它此前一个断言都没有——
  //    结果是这个端点从第二期重建起就一直在 500（`pin_hash` 写成了裸列名，
  //    而那一列早已搬到 member_pins），三周没人发现。所以下面几条要写死，
  //    尤其 `200` 和「列表非空」：只断言字段存在的话，
  //    500 时 `body.members` 是 undefined，`(x ?? []).every(...)` 会**空数组
  //    通过**，绿得毫无意义（第一版就是这么写的）。
  eq('GET /members 返回 200', 200, list1.status);
  const all = list1.body.members ?? [];
  eq('成员列表里有两个身份（阿头 + 别人）', 2, all.length);
  eq(
    '成员列表每条都带 avatar 字段',
    true,
    all.length > 0 && all.every((m) => 'avatar' in m),
  );
  eq('列表里阿头的头像就是刚设的 fox', 'fox', all.find((m) => m.id === meId)?.avatar);

  // hasPin 曾经就是那条 500 的直接原因，单独钉一下：设之前 false，设之后 true。
  // 只查一次「有 hasPin 字段」是抓不到这条的——字段名对、值全错也能过。
  eq('还没设 PIN 时 hasPin 为 false', false, all.find((m) => m.id === meId)?.hasPin);
  await E.post('/auth/pin', { pin: '2468' });
  const list2 = await E.get('/members');
  eq('设完 PIN 之后 hasPin 变成 true', true, list2.body.members?.find((m) => m.id === meId)?.hasPin);
  eq('设 PIN 不影响别人的 hasPin', false, list2.body.members?.find((m) => m.id === otherId)?.hasPin);

  // 5) 清空：null 是合法值，表示回到首字母兜底。
  //    和「传了非法值」必须分开——非法值上面已经断言是 400。
  const clear = await E.patch(`/members/${meId}`, { avatar: null });
  eq('清空头像 200', 200, clear.status);
  const me3 = await E.get('/auth/me');
  eq('清空后读回来是 null', null, me3.body.member?.avatar);
}

// ── 13. 篡改数据库（用一次性账号，不污染前面的状态）───────────────
section('13. 越权：直接改库绕过路由校验（fail closed）');
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

// ── 14. 公告的作者权限 ───────────────────────────────────────────
//
// 这一节守的是一条**前后端不一致**：前端把「编辑 / 删除」按钮只画给作者，
// 后端却只校验房间归属，于是任何房间成员直接调 API 就能改删别人的公告——
// 界面表达的那条规则在后端并不存在。
//
// ⚠️ 关键分界线是**内容 vs 展示位置**，不是「整个 PATCH 一视同仁」：
//    - title / content  → 只有作者（改的是别人写的话）
//    - isPinned         → 所有人（改的是「这条排多前」，前端也把按钮画给所有人）
//    所以下面**必须**有一条「乙置顶甲的公告 → 200」。如果哪天有人把作者校验
//    加到了整个 PATCH 上，那条会挂，而它挂正是对的——否则前端那颗对所有人
//    可见的置顶按钮会开始吃 403。
section('14. 公告：只有作者能改内容，置顶所有人可用');
{
  const F = new Jar();
  const G = new Jar();

  const regF = await F.post('/auth/register', { email: `annf${stamp}@example.com`, password: PW });
  eq('甲注册 201', 201, regF.status);
  const made = await F.post('/auth/household', { householdName: '公告测试房', memberName: '甲' });
  eq('甲建房 201', 201, made.status);
  const fMemberId = made.body.member?.id;

  const regG = await G.post('/auth/register', { email: `anng${stamp}@example.com`, password: PW });
  eq('乙注册 201', 201, regG.status);
  const joined = await G.post('/auth/join', {
    inviteCode: made.body.household?.inviteCode,
    name: '乙',
  });
  eq('乙加入同一房间 201', 201, joined.status);
  const gMemberId = joined.body.member?.id;
  eq('甲和乙是两个不同的成员', true, !!gMemberId && gMemberId !== fMemberId);

  const post = await F.post('/announcements', { title: '周六保洁', content: '上午十点来打扫' });
  eq('甲发公告 201', 201, post.status);
  const aid = post.body.announcement?.id;
  eq('返回的作者是甲', fMemberId, post.body.announcement?.authorId);

  // 1) 乙改甲的内容 → 403
  const gEditTitle = await G.patch(`/announcements/${aid}`, { title: '周六保洁（乙改的）' });
  eq('乙改别人的标题 403', 403, gEditTitle.status);
  const gEditBody = await G.patch(`/announcements/${aid}`, { content: '乙改的内容' });
  eq('乙改别人的内容 403', 403, gEditBody.status);

  // 2) 乙置顶甲的公告 → 200。本节的分界线，别删。
  const gPin = await G.patch(`/announcements/${aid}`, { isPinned: true });
  eq('乙置顶别人的公告 200', 200, gPin.status);

  // 3) 读回来：内容一个字没变，但置顶确实生效了。
  //    只断言 403 是不够的——403 之后内容被改掉也能全绿。
  const list1 = await F.get('/announcements');
  const a1 = (list1.body.announcements ?? []).find((x) => x.id === aid);
  eq('公告还在', true, !!a1);
  eq('标题没被乙改掉', '周六保洁', a1?.title);
  eq('内容没被乙改掉', '上午十点来打扫', a1?.content);
  eq('置顶确实生效了', true, a1?.isPinned);

  // 4) 乙删甲的 → 403，且真的没删掉
  const gDel = await G.del(`/announcements/${aid}`);
  eq('乙删别人的公告 403', 403, gDel.status);
  const list2 = await F.get('/announcements');
  eq('被拒之后公告还在', true, (list2.body.announcements ?? []).some((x) => x.id === aid));

  // 5) 甲改自己的、删自己的 → 200（别把作者本人也挡在外面）
  const fEdit = await F.patch(`/announcements/${aid}`, { title: '周六保洁（改期）' });
  eq('作者改自己的 200', 200, fEdit.status);
  const list3 = await F.get('/announcements');
  eq('作者的改动生效了', '周六保洁（改期）', (list3.body.announcements ?? []).find((x) => x.id === aid)?.title);

  const fDel = await F.del(`/announcements/${aid}`);
  eq('作者删自己的 200', 200, fDel.status);
  const list4 = await F.get('/announcements');
  eq('删掉之后列表里没有了', false, (list4.body.announcements ?? []).some((x) => x.id === aid));

  // 6) 反向再走一遍：规则不该是单向的。乙发的，甲同样改不了删不了，
  //    但置顶照样可以——如果这条挂了而上面那条过了，说明校验写反了。
  const gPost = await G.post('/announcements', { title: '乙的公告', content: '乙写的内容' });
  eq('乙也能发公告 201', 201, gPost.status);
  const gAid = gPost.body.announcement?.id;

  const fEditG = await F.patch(`/announcements/${gAid}`, { content: '甲改的' });
  eq('甲改乙的公告同样 403', 403, fEditG.status);
  const fDelG = await F.del(`/announcements/${gAid}`);
  eq('甲删乙的公告 403', 403, fDelG.status);
  const fPinG = await F.patch(`/announcements/${gAid}`, { isPinned: true });
  eq('但甲可以置顶乙的公告', 200, fPinG.status);

  await G.del(`/announcements/${gAid}`);
}

// ── 15. 退租 / 恢复的权限 ────────────────────────────────────────
//
// 守的是「退租不区分退谁」：这两个端点原来只校验「这条档案属于本房间」，
// 也就是**谁都能退谁、谁都能恢复谁**。其中 `restore` 更重——它把 is_active
// 翻回 1，而中间件正是按 `m.is_active = 1` join 出成员身份的，所以恢复一个人
// 等于**把他的账号重新放进这个房间**，能看到全部账目。那不是「标记错了可以
// 撤回」，那是单向的授权操作。
//
// ⚠️ 占位例外（`account_id IS NULL`）必须一起钉住，它不是顺手放宽：
//    占位档案是「先替还没进来的人建好名字」，它根本没有账号，**永远没法退
//    自己**。一律锁成「只能退自己」的话，一个最终没搬进来的占位档案会永久
//    卡在在住名单里——没有删除端点，只有退租。所以规则是
//    「有账号的只能自己动，没账号的谁都能动」。
//
// ⚠️ 本节最后一条断言记录的是一个**设计后果**，不是 bug：已认领的成员自己
//    退租之后，`restore` 对他实际上不可达（别人调是 403，他自己调时已经没有
//    成员身份、只会拿到 NO_MEMBERSHIP）。唯一的回头路是**用邀请码重新加入**，
//    它会沿用原来的 members.id（见第 11 节）。所以这条路径必须在这里被钉住，
//    否则哪天有人把它改坏了，退租就真的变成不可逆的了。
section('15. 退租 / 恢复只能动自己的身份，占位档案例外');
{
  const H = new Jar();
  const I = new Jar();

  await H.post('/auth/register', { email: `leaveh${stamp}@example.com`, password: PW });
  const made = await H.post('/auth/household', { householdName: '退租测试房', memberName: '房东' });
  eq('甲建房 201', 201, made.status);
  const hMemberId = made.body.member?.id;
  const invite = made.body.household?.inviteCode;

  await I.post('/auth/register', { email: `leavei${stamp}@example.com`, password: PW });
  const joined = await I.post('/auth/join', { inviteCode: invite, name: '租客' });
  eq('乙加入同一房间 201', 201, joined.status);
  const iMemberId = joined.body.member?.id;
  eq('甲和乙是两个不同的成员', true, !!iMemberId && iMemberId !== hMemberId);

  const ph = await H.post('/members', { name: '还没搬进来的人' });
  eq('占位档案创建 201', 201, ph.status);
  const phId = ph.body.member?.id;

  // 0) 前端画按钮的依据就是这个字段，先把三种身份区分清楚。
  //    只断言「有 hasAccount 字段」抓不到这条——字段名对、恒为 true 也能过。
  const list0 = await H.get('/members');
  eq('GET /members 返回 200', 200, list0.status);
  const at = (m) => list0.body.members?.find((x) => x.id === m);
  eq('新建的占位档案 hasAccount 为 false', false, ph.body.member?.hasAccount);
  eq('已认领的甲 hasAccount 为 true', true, at(hMemberId)?.hasAccount);
  eq('已认领的乙 hasAccount 为 true', true, at(iMemberId)?.hasAccount);
  eq('占位档案在列表里 hasAccount 为 false', false, at(phId)?.hasAccount);

  // 1) 越权：动别人的已认领身份 → 三个方向全部 403
  //
  // ⚠️ 这三个 403 **必须连文案一起断言**，光看状态码不行。
  //    把 canManage 短路成 `return true` 实测过：乙退甲真的成功后，甲的会话
  //    当场失去成员身份，于是后面两条「甲…403」仍然返回 403——只不过原因是
  //    NO_MEMBERSHIP 而不是「只能退租自己的身份」。**两条断言会因为错误的
  //    理由通过**，而它们守的恰是这一节的核心。所以下面比的是 error 文案。
  const crossLeave = await I.post(`/members/${hMemberId}/leave`);
  eq('乙退甲 403', 403, crossLeave.status);
  eq('且理由是「只能退租自己的身份」', '只能退租自己的身份', crossLeave.body?.error);

  const crossLeave2 = await H.post(`/members/${iMemberId}/leave`);
  eq('甲退乙 403', 403, crossLeave2.status);
  eq('理由同上，不是 NO_MEMBERSHIP', '只能退租自己的身份', crossLeave2.body?.error);

  const crossRestore = await H.post(`/members/${iMemberId}/restore`);
  eq('甲恢复乙 403', 403, crossRestore.status);
  eq('恢复用的是另一套话术', '只能恢复自己的身份', crossRestore.body?.error);

  // 拒绝之后必须真的没动到——只看 403 的话，403 之前先写了库也能全绿
  const list1 = await H.get('/members');
  eq('被拒之后甲还在住', true, list1.body.members?.find((m) => m.id === hMemberId)?.isActive);
  eq('被拒之后乙还在住', true, list1.body.members?.find((m) => m.id === iMemberId)?.isActive);

  // 2) 占位例外：没有账号的档案谁都能操作（它自己动不了）
  eq('甲退占位档案 200', 200, (await H.post(`/members/${phId}/leave`)).status);
  const list2 = await H.get('/members');
  eq('占位档案退租后 isActive 为 false', false, list2.body.members?.find((m) => m.id === phId)?.isActive);

  eq('乙也能恢复占位档案 200', 200, (await I.post(`/members/${phId}/restore`)).status);
  const list3 = await H.get('/members');
  eq('恢复后占位档案在住', true, list3.body.members?.find((m) => m.id === phId)?.isActive);
  // 「恢复在住」不等于「认领」：占位档案恢复回来还是占位档案
  eq('恢复一个人不等于认领它', false, list3.body.members?.find((m) => m.id === phId)?.hasAccount);

  // 3) 自己退自己 → 200（别把本人也挡在外面）
  eq('乙退自己 200', 200, (await I.post(`/members/${iMemberId}/leave`)).status);

  const me = await I.get('/auth/me');
  eq('退租后 /auth/me 仍是 200（登录态还在）', 200, me.status);
  eq('退租后 household 为 null', null, me.body.household);
  const bal = await I.get('/balance');
  eq('退租后查余额 403', 403, bal.status);
  eq('且是 NO_MEMBERSHIP 而不是 SESSION_EXPIRED', 'NO_MEMBERSHIP', bal.body.code);

  // 4) 退租之后 restore 对他不可达。这正是「恢复是授权操作」的代价：
  //    别人不能替他恢复（下一条），他自己又没有身份去调（上一段）。
  const helpRestore = await H.post(`/members/${iMemberId}/restore`);
  eq('甲想替乙恢复 403', 403, helpRestore.status);
  eq('用的是权限话术，不是 NO_MEMBERSHIP', '只能恢复自己的身份', helpRestore.body?.error);
  const list4 = await H.get('/members');
  eq('乙的档案还在（历史账目要挂在这条上，不能删）', true, !!list4.body.members?.find((m) => m.id === iMemberId));
  eq('只是被标记成已退租', false, list4.body.members?.find((m) => m.id === iMemberId)?.isActive);
  eq('已退租的档案仍然标着「已认领」', true, list4.body.members?.find((m) => m.id === iMemberId)?.hasAccount);

  // 5) 唯一那条回头路：用邀请码重新加入，沿用原来的 members.id
  const back = await I.post('/auth/join', { inviteCode: invite, name: '租客' });
  eq('乙用邀请码重新加入 200', 200, back.status);
  eq('沿用原档案，不新建身份', iMemberId, back.body.member?.id);
  const bal2 = await I.get('/balance');
  eq('回到房间后能正常查余额', 200, bal2.status);
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
