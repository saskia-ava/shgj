/**
 * 「谁该给谁多少钱」—— 整个应用最容易写错的地方。
 *
 * 全程纯函数、全程整数分，不碰数据库，便于单测覆盖。
 */

export interface ExpenseRecord {
  id: string;
  amount: number; // 分
  paidBy: string; // 垫付人的 memberId
}

export interface ShareRecord {
  expenseId: string;
  memberId: string;
  shareAmount: number; // 分
}

export interface SettlementRecord {
  fromMember: string;
  toMember: string;
  amount: number; // 分
}

export interface Transfer {
  from: string; // 付款方（欠钱的人）
  to: string; // 收款方（被欠钱的人）
  amount: number; // 分
}

/**
 * 计算每个成员的净余额。
 *
 * 符号约定：balance > 0 表示别人欠他钱（应收），< 0 表示他欠别人钱（应付）。
 *
 *   balance[m] =  Σ 由 m 垫付的账目金额     // 我替大家付了，大家欠我
 *              −  Σ m 应分摊的份额           // 我该承担的部分
 *              +  Σ m 转出去的钱             // 我还了债，应收回升
 *              −  Σ m 收到的钱               // 别人还我了，应收回落
 *
 * 注意结算项的符号方向：转账出去是「还债」，会让自己的应收**增加**（从负数往 0 走）；
 * 收到转账是「被还债」，会让应收**减少**。写反了会导致还款后欠得更多。
 *
 * 数学性质：Σ balance[m] === 0 恒成立（每笔账目的分摊额之和等于账目金额）。
 * 代码里对这个恒等式做断言——一旦不为 0，说明分摊数据写坏了。
 */
export function computeBalances(
  memberIds: string[],
  expenses: ExpenseRecord[],
  shares: ShareRecord[],
  settlements: SettlementRecord[],
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const id of memberIds) balances.set(id, 0);

  const bump = (memberId: string, delta: number) => {
    const current = balances.get(memberId);
    if (current === undefined) {
      throw new Error(`账目引用了不在本房间的成员：${memberId}`);
    }
    balances.set(memberId, current + delta);
  };

  for (const e of expenses) bump(e.paidBy, e.amount);
  for (const s of shares) bump(s.memberId, -s.shareAmount);
  for (const t of settlements) {
    bump(t.fromMember, t.amount);
    bump(t.toMember, -t.amount);
  }

  const total = [...balances.values()].reduce((a, b) => a + b, 0);
  if (total !== 0) {
    throw new Error(`账目对不平：所有成员余额之和应为 0，实际为 ${total} 分。分摊数据可能已损坏。`);
  }

  return balances;
}

/**
 * 把净余额化简成「最少转账笔数」的结算建议。
 *
 * 朴素做法是每个人给每个债权人各转一笔，n 人最多 n² 笔。这里贪心配对
 * （最大债权人 ↔ 最大债务人），结果不超过 n−1 笔。
 *
 * 严格最优解等价于子集和问题（NP-hard），贪心已经足够好，不值得为此增加复杂度。
 */
export function suggestTransfers(balances: Map<string, number>): Transfer[] {
  // 只保留有实际金额的成员，避免 0 值参与排序
  const creditors = [...balances.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1]);
  const debtors = [...balances.entries()]
    .filter(([, amount]) => amount < 0)
    .sort((a, b) => a[1] - b[1]);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;

  while (i < creditors.length && j < debtors.length) {
    const [creditorId, credit] = creditors[i];
    const [debtorId, debt] = debtors[j];
    const amount = Math.min(credit, -debt);

    if (amount > 0) {
      transfers.push({ from: debtorId, to: creditorId, amount });
    }

    creditors[i] = [creditorId, credit - amount];
    debtors[j] = [debtorId, debt + amount];

    if (creditors[i][1] === 0) i++;
    if (debtors[j][1] === 0) j++;
  }

  return transfers;
}

/** 便捷组合：从原始记录直接算出余额与结算建议。 */
export function settle(
  memberIds: string[],
  expenses: ExpenseRecord[],
  shares: ShareRecord[],
  settlements: SettlementRecord[],
): { balances: Map<string, number>; transfers: Transfer[] } {
  const balances = computeBalances(memberIds, expenses, shares, settlements);
  return { balances, transfers: suggestTransfers(balances) };
}
