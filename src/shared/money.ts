/**
 * 金额处理：全程整数「分」运算。
 *
 * 绝不用浮点数存/算金额。0.1 + 0.2 !== 0.3 这类误差在累加多笔账目后
 * 会让「谁欠谁多少」直接算不平，且极难排查。只在渲染时转成「元」。
 */

/** 「元」字符串/数字 → 「分」整数。不经过浮点运算，避免精度损失。 */
export function yuanToCents(input: string | number): number {
  const raw = String(input).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`金额格式不正确：${raw}`);
  }
  const negative = raw.startsWith('-');
  const [intPart, decPart = ''] = raw.replace('-', '').split('.');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** 「分」整数 → 「元」字符串，固定两位小数。 */
export function centsToYuan(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`金额必须是整数分，收到：${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 均摊：把 totalCents 平均分给 memberIds，余数分配给靠前的成员。
 *
 * 返回的每一份都是整数分，且总和严格等于 totalCents（一分不差）。
 * 调用方必须把结果落库（expense_shares），不要在查询时重算——
 * 否则余数分配规则一旦调整，历史账目会跟着漂移。
 */
export function splitEqually(totalCents: number, memberIds: string[]): Map<string, number> {
  const n = memberIds.length;
  if (n === 0) {
    throw new Error('至少需要一个分摊成员');
  }
  if (!Number.isInteger(totalCents)) {
    throw new Error(`金额必须是整数分，收到：${totalCents}`);
  }

  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;

  const result = new Map<string, number>();
  for (const id of memberIds) {
    const extra = remainder > 0 ? 1 : 0;
    result.set(id, base + extra);
    remainder -= extra;
  }
  return result;
}

/** 校验一组分摊金额之和是否严格等于账目总额。 */
export function sharesSumTo(totalCents: number, shares: { shareAmount: number }[]): boolean {
  return shares.reduce((sum, s) => sum + s.shareAmount, 0) === totalCents;
}
