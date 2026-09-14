/**
 * 逐个打认证端点，每个恰好一次，供 `wrangler tail` 抓 cpuTime。
 *
 *   # 终端 1（大陆网络要带代理，tail 走 WebSocket，和 HTTP 一样会被墙）
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     npx wrangler tail --format json
 *   # 终端 2（fetch 也要代理，同上）
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     HZM_BASE=https://<域名>/api node scripts/measure-cpu.mjs
 *   # 然后
 *   node scripts/measure-cpu.mjs --report tail.json     # 按端点汇总取最大值
 *   node scripts/measure-cpu.mjs --samples tail.json    # 按发生顺序逐条列出
 *
 * **至少要跑三轮再来读 `--report`。** 一轮等于每个端点只有 1 个样本，
 * 而开机/冷启动的摊销会全部算到那一轮的头几个请求上，看起来像「register
 * 24ms，超限了」。实测三轮下来，第 3 轮才是真正稳定的数字。
 * `--samples` 就是用来分辨这两者的：同一端点连着几轮的采样值一路下降，
 * 降到一个平台期，那是冷启动；一直高，那才是真的贵。
 *
 * 为什么要单独一个脚本：免费版单请求只有 10ms CPU，超了直接 Error 1102。
 * **这个数字只能实测，不能推算**——本机 Node 比 Cloudflare 快约 3 倍，
 * 25,000 轮在本机是 3.3ms（看着很安全），线上实测 10~14ms，直接超限。
 *
 * ⚠️ 超了 10ms 不等于会挂。见 `--report` 末尾那段说明：本账号实测
 *    register 24ms 仍然 `outcome: ok`，10ms 上限并没有被强制。
 *
 * 每条路径都在下面标了它跑几次 PBKDF2。改认证逻辑之后请重跑一遍。
 */

import { readFileSync } from 'node:fs';

const BASE = process.env.HZM_BASE ?? 'http://localhost:5173/api';

// ── tail 输出解析（--report 与 --samples 共用）─────────────────────

/**
 * `wrangler tail --format json` 输出的是**跨多行 pretty-print** 的 JSON 对象，
 * 一个接一个直接拼在一起，**不是**一行一个。按行 JSON.parse 会全部失败，
 * 于是得到一个空结果——看起来像「没有任何请求」。
 *
 * 所以这里用括号深度扫描把拼接的对象切开。字符串字面量和转义都要跳过，
 * 否则 URL 或 header 里的 `{` `}` 会把深度算歪。
 */
function splitJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** 读出按**发生顺序**排列的 /api/ 请求事件。 */
function readEvents(file) {
  const raw = readFileSync(file, 'utf8');
  const events = [];
  for (const chunk of splitJsonObjects(raw)) {
    let ev;
    try {
      ev = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (ev.event?.request?.url === undefined) continue;
    const url = new URL(ev.event.request.url);
    if (!url.pathname.startsWith('/api/')) continue;
    events.push({
      key: `${ev.event.request.method} ${url.pathname}`,
      // cpuTime 在**顶层**，不在 event.request 里。单位是毫秒。
      cpu: ev.cpuTime ?? 0,
      outcome: ev.outcome,
    });
  }
  return events;
}

/**
 * ⚠️ 一条都没抓到时必须报错，**不能报绿**。
 *    tail 连不上（大陆网络下 wrangler tail 的 WebSocket 会被墙）或者
 *    probe 没跑，都会得到空文件。此时打印「0 个端点全部低于 10ms」
 *    是纯粹的假通过——它看起来和「实测过了，全部达标」一模一样。
 */
function dieIfEmpty(events) {
  if (events.length > 0) return;
  console.error(
    '\x1b[31mtail 输出里没有任何 /api/ 请求，无法得出结论。\x1b[0m\n' +
      '多半是 wrangler tail 根本没连上（大陆网络需要代理，它是 WebSocket，' +
      '和 HTTP 一样会被墙），或者探测脚本没有跑。\n' +
      '先确认 tail 起来了再跑 measure-cpu.mjs。',
  );
  process.exit(1);
}

// ── 逐条模式：按发生顺序列出，用来分辨冷启动与稳态 ────────────────
if (process.argv.includes('--samples')) {
  const file = process.argv[process.argv.indexOf('--samples') + 1];
  const events = readEvents(file);
  dieIfEmpty(events);

  console.log('按发生顺序（每次探测脚本的运行会重复一遍全部端点）：\n');
  console.log('#'.padStart(4) + ' 端点'.padEnd(38) + 'CPU'.padStart(9) + '  结果');
  console.log('─'.repeat(62));
  events.forEach((e, i) => {
    const color = e.cpu >= 10 ? '\x1b[31m' : e.cpu >= 7 ? '\x1b[33m' : '';
    console.log(
      String(i + 1).padStart(4) +
        ' ' +
        e.key.padEnd(38) +
        `${color}${e.cpu.toFixed(2)}ms\x1b[0m`.padStart(9 + color.length + 4) +
        '  ' + (e.outcome === 'ok' ? 'ok' : `\x1b[31m${e.outcome}\x1b[0m`),
    );
  });
  process.exit(0);
}

// ── 报告模式：按端点汇总取最大值 ──────────────────────────────────
if (process.argv.includes('--report')) {
  const file = process.argv[process.argv.indexOf('--report') + 1];
  const events = readEvents(file);
  dieIfEmpty(events);

  /** path → { max, n } */
  const byPath = new Map();
  const over = [];

  for (const e of events) {
    const cur = byPath.get(e.key) ?? { max: 0, n: 0 };
    cur.max = Math.max(cur.max, e.cpu);
    cur.n++;
    byPath.set(e.key, cur);
    if (e.cpu >= 10) over.push(e);
  }

  const rows = [...byPath.entries()].sort((a, b) => b[1].max - a[1].max);

  console.log('端点'.padEnd(38) + '最大 CPU'.padStart(10) + '次数'.padStart(7));
  console.log('─'.repeat(56));
  for (const [key, v] of rows) {
    const flag = v.max >= 10 ? '\x1b[31m  ← 超限\x1b[0m' : v.max >= 7 ? '\x1b[33m  ← 接近\x1b[0m' : '';
    console.log(key.padEnd(38) + `${v.max.toFixed(2)}ms`.padStart(10) + String(v.n).padStart(7) + flag);
  }
  console.log('');

  if (over.length > 0) {
    console.error(`\x1b[31m${over.length} 次请求超过 10ms：\x1b[0m`);
    for (const o of over) console.error(`  ${o.key}  ${o.cpu}ms  outcome=${o.outcome}`);
    console.error('');
  }

  // ⚠️ 这里刻意**不**把「超 10ms」直接判成失败。
  //    实测过：register 跑到 24ms 仍然是 outcome=ok，免费版这个 10ms 上限
  //    在本账号上并没有被强制（真被强制时 outcome 会是 exceededCpu，
  //    响应体是 Error 1102）。所以有超限样本时不能只看 CPU 数字，
  //    要看 outcome——真正该报警的是 outcome 异常。
  const killed = events.filter((e) => e.outcome !== 'ok');
  if (killed.length > 0) {
    console.error(`\x1b[31m有 ${killed.length} 次请求 outcome 不是 ok——这些才是真的挂了：\x1b[0m`);
    for (const k of killed) console.error(`  ${k.key}  ${k.cpu}ms  outcome=${k.outcome}`);
    process.exit(1);
  }

  if (over.length === 0) {
    console.log(`\x1b[32m${rows.length} 个端点全部低于 10ms，且全部请求 outcome=ok。\x1b[0m`);
  } else {
    console.log(
      `\x1b[33m有 ${over.length} 次超过 10ms，但**全部 outcome=ok**——没被 CPU 上限掐掉。\x1b[0m\n` +
        '别拿最大值当结论：一轮探测里每个端点只有 1 个样本，冷启动的摊销会\n' +
        '全落在那轮的头几个请求上。用 --samples 看逐条数值，跑三轮以上再判断。',
    );
  }
  process.exit(0);
}

// ── 探测模式 ──────────────────────────────────────────────────────

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
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, body: json };
  }
  get = (p) => this.req('GET', p);
  post = (p, b) => this.req('POST', p, b ?? {});
}

const PW = 'correct-horse-1';
const t = Date.now();
const MAIL = `cpu${t}@example.com`;
const A = new Jar();

let invite, memberId, householdId;

async function step(label, fn) {
  const r = await fn();
  const okMark = r.status < 400 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${okMark} ${String(r.status).padEnd(4)} ${label}`);
  return r;
}

console.log('每个端点打一次，看 wrangler tail 里的 cpuTime\n');

// ⚠️ Node 的 fetch 不会自动读 HTTPS_PROXY，必须显式开 NODE_USE_ENV_PROXY=1。
//    不开的时候报的是 `ConnectTimeoutError`，看起来像「线上挂了」，
//    其实只是 workers.dev 在大陆直连不通。这里把话说清楚，
//    否则下一次还是会先怀疑服务端。
process.on('uncaughtException', (err) => {
  const cause = err?.cause ?? err;
  if (String(cause?.code ?? '').includes('CONNECT_TIMEOUT') || String(err?.cause?.code ?? '') === 'UND_ERR_CONNECT_TIMEOUT') {
    console.error(
      '\n\x1b[31m连不上 ' + BASE + '\x1b[0m\n\n' +
        '这多半不是服务端的问题。workers.dev 在大陆直连不通，' +
        '探测脚本和 wrangler tail **两边都要走代理**：\n\n' +
        '  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \\\n' +
        '    HZM_BASE=' + BASE + ' node scripts/measure-cpu.mjs\n',
    );
    process.exit(1);
  }
  throw err;
});

// 1 次 PBKDF2（6,000 轮）—— 最贵的一条路径
await step('POST /auth/register                  1×PBKDF2(6000)', () =>
  A.post('/auth/register', { email: MAIL, password: PW }),
);

// 建房不设 PIN，0 次 PBKDF2
const hh = await step('POST /auth/household                 0×PBKDF2', () =>
  A.post('/auth/household', { householdName: 'CPU 测试房', memberName: '测试员' }),
);
invite = hh.body.household?.inviteCode;
memberId = hh.body.member?.id;
householdId = hh.body.household?.id;

await step('GET  /auth/me                        1 次查询', () => A.get('/auth/me'));
await step('GET  /balance                        业务路由', () => A.get('/balance'));

// 设 PIN：没有旧 PIN，所以只有 1 次 PBKDF2(1,000)
await step('POST /auth/pin (首次)                1×PBKDF2(1000)', () =>
  A.post('/auth/pin', { pin: '2468' }),
);

// ★ 唯一的两段式路径：验旧 + 算新 = 2 次 PBKDF2(1,000)
await step('POST /auth/pin (改)                  2×PBKDF2(1000)', () =>
  A.post('/auth/pin', { pin: '1357', currentPin: '2468' }),
);

await step('POST /auth/logout                    ', () => A.post('/auth/logout'));

// 登录：1 次 PBKDF2(6,000)
await step('POST /auth/login                     1×PBKDF2(6000)', () =>
  A.post('/auth/login', { email: MAIL, password: PW }),
);

// 账号不存在：也要跑一次等价 PBKDF2（防账号枚举的时序填充）
await step('POST /auth/login (不存在)             1×dummy PBKDF2', () =>
  A.post('/auth/login', { email: `nobody${t}@example.com`, password: PW }),
);

// PIN 登录：1 次 PBKDF2(1,000)
await step('POST /auth/login/pin                 1×PBKDF2(1000)', () =>
  A.post('/auth/login/pin', { inviteCode: invite, memberId, pin: '1357' }),
);

// 改密码两段：各自 1 次 PBKDF2(6,000)
await step('POST /auth/password/verify           1×PBKDF2(6000)', () =>
  A.post('/auth/password/verify', { password: PW }),
);
await step('POST /auth/password                  1×PBKDF2(6000)', () =>
  A.post('/auth/password', { newPassword: 'another-pass-9' }),
);

// 换恢复码：验密码 1 次 PBKDF2(6000) + 8 次 SHA-256（SHA-256 很便宜）
await step('POST /auth/recovery-codes            1×PBKDF2(6000) + 8×SHA256', () =>
  A.post('/auth/recovery-codes', { password: 'another-pass-9' }),
);

// 第二间房：已登录，0 次 PBKDF2
await step('POST /auth/household (第二间)         0×PBKDF2', () =>
  A.post('/auth/household', { householdName: 'CPU 测试房二', memberName: '测试员' }),
);
await step('POST /auth/switch                    1 条 UPDATE', () =>
  A.post('/auth/switch', { householdId }),
);

// 用恢复码重置：1 次 PBKDF2(6000)
await step('POST /auth/recovery                  1×PBKDF2(6000)', () =>
  A.post('/auth/recovery', { email: MAIL, code: 'ZZZZ-ZZZZ', newPassword: 'x-pass-1234' }),
);

// 加入第二间房（用新账号，走匿名路径 = 1 次 PBKDF2）
const B = new Jar();
await step('POST /auth/join (匿名)                1×PBKDF2(6000)', () =>
  B.post('/auth/join', {
    inviteCode: invite,
    name: '临时室友',
    email: `join${t}@example.com`,
    password: PW,
  }),
);

console.log('\n探测完成。用 --report 解析 tail 输出。');
