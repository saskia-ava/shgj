/**
 * 跑 scripts/verify-integrity.sql 并断言每一项 bad_rows 都是 0。
 *
 *   npm run db:verify:local     # 本地
 *   npm run db:verify           # 线上
 *
 * 有非零项就打印出来并以退出码 1 结束——这样它能当上线流程里的关卡用，
 * 而不需要有人去读一坨 JSON 自己数。
 *
 * ⚠️ 为什么逐条 `--command` 而不是整份文件 `--file`：
 *    本地（Miniflare）和线上（真 D1）对 `--file` 的处理**不一样**。
 *    本地会把每条语句的结果集都返回；线上走的是 import 通道，只返回一个汇总
 *    （`Total queries executed: N`），拿不到任何行。用它做校验的话，线上会
 *    「跑了 5 条语句、0 项非零」——看起来全绿，其实一行数据都没检查。
 *    逐条 `--command` 两边都返回行，行为一致。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const remote = process.argv.includes('--remote');
const where = remote ? '--remote' : '--local';

/**
 * 把 SQL 文件切成一条条语句。
 *
 * 先剥掉 `--` 行注释再按 `;` 切。verify-integrity.sql 里刻意不含**任何**
 * 出现在字符串或注释中间的分号，所以这个朴素切法是安全的——改那个文件时
 * 请保持这个性质，否则这里会静默地切出半条语句。
 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 直接用 node 跑 wrangler 的入口脚本，而不是 `npx` / `npx.cmd`。
// Node 24 起在 Windows 上禁止 spawnSync 直接执行 .cmd（抛 EINVAL），
// 而 `shell: true` 又会把参数拼成字符串。
function runSql(sql) {
  const out = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'hezu-db',
      where,
      '--json',
      '--command',
      sql,
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const start = out.indexOf('[');
  if (start < 0) throw new Error('没找到 JSON 输出，wrangler 可能报错了：\n' + out);
  const sets = JSON.parse(out.slice(start));
  return sets.flatMap((s) => s.results ?? []);
}

const statements = splitStatements(readFileSync('./scripts/verify-integrity.sql', 'utf8'));

const EXPECTED_TOTAL = 27;
let total = 0;
const bad = [];

for (const stmt of statements) {
  let rows;
  try {
    rows = runSql(stmt);
  } catch (err) {
    console.error(`\x1b[31m这条语句执行失败：\x1b[0m\n${stmt}\n`);
    console.error(err.message ?? err);
    process.exit(1);
  }
  for (const row of rows) {
    total++;
    if (row.bad_rows !== 0) bad.push(row);
  }
}

console.log(`数据完整性：检查 ${total} 项（${remote ? '线上' : '本地'}）`);

// 项数对不上说明文件被改坏了（比如又把语句合并回一个大 UNION ALL，
// 撞上 D1 那个 5 项的复合 SELECT 上限，整条语句被丢掉而不报错）。
if (total !== EXPECTED_TOTAL) {
  console.error(
    `\x1b[31m检查项数不对：期望 ${EXPECTED_TOTAL} 项，实际 ${total} 项。\x1b[0m\n` +
      '多半是 verify-integrity.sql 里的某条语句执行失败了，或被人合并回了大的 ' +
      'UNION ALL——D1 的复合 SELECT 上限是 5 项，超了会整条语句被丢掉。',
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
