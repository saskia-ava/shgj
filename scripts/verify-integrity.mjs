/**
 * 跑 scripts/verify-integrity.sql 并断言每一项 bad_rows 都是 0。
 *
 *   npm run db:verify:local     # 本地
 *   npm run db:verify           # 线上
 *
 * 有非零项就打印出来并以退出码 1 结束——这样它能当 CI / 上线流程里的关卡用，
 * 而不需要有人去读一坨 JSON 自己数。
 *
 * 为什么要有这个包装：`wrangler d1 execute --file` 的输出是一串 result set，
 * 直接看既费眼又容易漏。判读这件事应该交给机器。
 */

import { execFileSync } from 'node:child_process';

const remote = process.argv.includes('--remote');
const where = remote ? '--remote' : '--local';

// 直接用 node 跑 wrangler 的入口脚本，而不是 `npx` / `npx.cmd`。
// Node 24 起在 Windows 上禁止 spawnSync 直接执行 .cmd（抛 EINVAL），
// 而 `shell: true` 又会把参数拼成字符串。绕开整个 .cmd 层最省事，
// 顺带让子进程和当前用的是同一个 node。
const out = execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'execute',
    'hezu-db',
    where,
    '--json',
    '--file=./scripts/verify-integrity.sql',
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

// wrangler 在 JSON 前面还会打几行 banner，从第一个 [ 开始才是结果
const start = out.indexOf('[');
if (start < 0) {
  console.error('没找到 JSON 输出，wrangler 可能报错了：\n' + out);
  process.exit(1);
}
const sets = JSON.parse(out.slice(start));

let total = 0;
const bad = [];
for (const set of sets) {
  for (const row of set.results ?? []) {
    total++;
    if (row.bad_rows !== 0) bad.push(row);
  }
}

console.log(`数据完整性：检查 ${total} 项（${remote ? '线上' : '本地'}）`);

// 项数对不上说明文件被改坏了（比如又把 UNION ALL 合并回去，撞上 D1 那个
// 5 项的复合 SELECT 上限，整条语句会被整段丢掉而不报错）。
const EXPECTED = 27;
if (total !== EXPECTED) {
  console.error(
    `\x1b[31m检查项数不对：期望 ${EXPECTED} 项，实际 ${total} 项。\x1b[0m\n` +
      '多半是 verify-integrity.sql 里的某条语句执行失败了——D1 的复合 SELECT ' +
      '上限是 5 项，超了会整条语句被丢掉。',
  );
  process.exit(1);
}

if (bad.length === 0) {
  console.log('\x1b[32m全部为 0，通过。\x1b[0m');
  process.exit(0);
}

console.error(`\x1b[31m${bad.length} 项非零：\x1b[0m`);
for (const row of bad) console.error(`  ${row.check_name} = ${row.bad_rows}`);
process.exit(1);
