import { describe, it, expect } from 'vitest';
import {
  computeBalances,
  suggestTransfers,
  settle,
  type ExpenseRecord,
  type ShareRecord,
  type SettlementRecord,
} from '../src/shared/balance';
import { splitEqually } from '../src/shared/money';

const equalShares = (expenseId: string, total: number, memberIds: string[]): ShareRecord[] =>
  [...splitEqually(total, memberIds)].map(([memberId, shareAmount]) => ({
    expenseId,
    memberId,
    shareAmount,
  }));

const sumOf = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('computeBalances', () => {
  it('一人垫付、三人均摊', () => {
    // A 垫付 300 元房租，三人均摊，每人 100 元
    const members = ['a', 'b', 'c'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 30000, paidBy: 'a' }];
    const shares = equalShares('e1', 30000, members);

    const balances = computeBalances(members, expenses, shares, []);

    expect(balances.get('a')).toBe(20000); // 垫了 300，自己该担 100，净应收 200
    expect(balances.get('b')).toBe(-10000);
    expect(balances.get('c')).toBe(-10000);
    expect(sumOf(balances)).toBe(0);
  });

  it('多人多笔账目混合', () => {
    const members = ['a', 'b', 'c'];
    const expenses: ExpenseRecord[] = [
      { id: 'e1', amount: 30000, paidBy: 'a' }, // 房租
      { id: 'e2', amount: 9000, paidBy: 'b' }, // 水电
      { id: 'e3', amount: 3000, paidBy: 'c' }, // 网费
    ];
    const shares = [
      ...equalShares('e1', 30000, members),
      ...equalShares('e2', 9000, members),
      ...equalShares('e3', 3000, members),
    ];

    const balances = computeBalances(members, expenses, shares, []);

    expect(sumOf(balances)).toBe(0);
    expect(balances.get('a')).toBe(30000 - 10000 - 3000 - 1000); // 16000
    expect(balances.get('b')).toBe(9000 - 10000 - 3000 - 1000); // -5000
    expect(balances.get('c')).toBe(3000 - 10000 - 3000 - 1000); // -11000
  });

  it('自定义比例分摊（一方多担）', () => {
    const members = ['a', 'b'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 10000, paidBy: 'a' }];
    const shares: ShareRecord[] = [
      { expenseId: 'e1', memberId: 'a', shareAmount: 3000 },
      { expenseId: 'e1', memberId: 'b', shareAmount: 7000 },
    ];

    const balances = computeBalances(members, expenses, shares, []);

    expect(balances.get('a')).toBe(7000);
    expect(balances.get('b')).toBe(-7000);
  });

  it('★ 结算符号方向：还款后欠款必须减少，而不是增加', () => {
    // 这是最容易写反的地方。B 欠 A 100 元，B 转了 100 元给 A 之后，
    // 双方余额都应该归零。
    const members = ['a', 'b'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 20000, paidBy: 'a' }];
    const shares = equalShares('e1', 20000, members);
    const settlements: SettlementRecord[] = [{ fromMember: 'b', toMember: 'a', amount: 10000 }];

    const balances = computeBalances(members, expenses, shares, settlements);

    expect(balances.get('a')).toBe(0);
    expect(balances.get('b')).toBe(0);
    expect(sumOf(balances)).toBe(0);
  });

  it('部分还款后余额正确递减', () => {
    const members = ['a', 'b'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 20000, paidBy: 'a' }];
    const shares = equalShares('e1', 20000, members);
    const settlements: SettlementRecord[] = [{ fromMember: 'b', toMember: 'a', amount: 4000 }];

    const balances = computeBalances(members, expenses, shares, settlements);

    expect(balances.get('a')).toBe(6000); // 应收从 10000 降到 6000
    expect(balances.get('b')).toBe(-6000);
  });

  it('退租成员（is_active=0）的历史账目仍被正确计入', () => {
    // 退租只是不再出现在「可选成员」列表里，不参与分摊算法。
    // 只要他的 id 在 memberIds 里，历史余额就必须照常计算。
    const members = ['a', 'b', 'retired'];
    const expenses: ExpenseRecord[] = [
      { id: 'e1', amount: 30000, paidBy: 'retired' },
      { id: 'e2', amount: 30000, paidBy: 'a' },
    ];
    const shares = [...equalShares('e1', 30000, members), ...equalShares('e2', 30000, members)];

    const balances = computeBalances(members, expenses, shares, []);

    expect(sumOf(balances)).toBe(0);
    // retired 垫付 e1 的 300 元，但要承担 e1、e2 各 100 元 → 净应收 100 元
    expect(balances.get('retired')).toBe(10000);
    // a 垫付 e2 的 300 元，同样要承担两笔各 100 元
    expect(balances.get('a')).toBe(10000);
    // b 没垫过钱，承担两笔各 100 元
    expect(balances.get('b')).toBe(-20000);
  });

  it('引用未知成员时报错，而不是静默算错', () => {
    expect(() =>
      computeBalances(['a'], [{ id: 'e1', amount: 100, paidBy: 'ghost' }], [], []),
    ).toThrow(/不在本房间/);
  });

  it('账目对不平时抛出断言错误', () => {
    // 分摊之和 8000 ≠ 账目金额 10000，属于数据损坏
    const members = ['a', 'b'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 10000, paidBy: 'a' }];
    const shares: ShareRecord[] = [{ expenseId: 'e1', memberId: 'b', shareAmount: 8000 }];

    expect(() => computeBalances(members, expenses, shares, [])).toThrow(/对不平/);
  });

  it('全部结清后所有人归零', () => {
    const members = ['a', 'b', 'c'];
    const expenses: ExpenseRecord[] = [{ id: 'e1', amount: 30000, paidBy: 'a' }];
    const shares = equalShares('e1', 30000, members);
    const settlements: SettlementRecord[] = [
      { fromMember: 'b', toMember: 'a', amount: 10000 },
      { fromMember: 'c', toMember: 'a', amount: 10000 },
    ];

    const balances = computeBalances(members, expenses, shares, settlements);

    expect([...balances.values()]).toEqual([0, 0, 0]);
  });

  it('无账目时全为 0', () => {
    const balances = computeBalances(['a', 'b'], [], [], []);
    expect([...balances.values()]).toEqual([0, 0]);
  });
});

describe('suggestTransfers', () => {
  it('三人均摊 → 最多 2 笔转账', () => {
    const balances = new Map([
      ['a', 20000],
      ['b', -10000],
      ['c', -10000],
    ]);

    const transfers = suggestTransfers(balances);

    expect(transfers).toHaveLength(2);
    expect(transfers.every((t) => t.to === 'a')).toBe(true);

    const total = transfers.reduce((sum, t) => sum + t.amount, 0);
    expect(total).toBe(20000);
  });

  it('n 人场景转账笔数不超过 n−1', () => {
    for (let n = 2; n <= 30; n++) {
      const balances = new Map<string, number>();
      // 构造一个必定对得平的随机余额分布
      let running = 0;
      for (let i = 0; i < n - 1; i++) {
        const v = (i % 2 === 0 ? 1 : -1) * (i * 137 + 1);
        balances.set(`m${i}`, v);
        running += v;
      }
      balances.set(`m${n - 1}`, -running);

      const transfers = suggestTransfers(balances);
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, n - 1));

      // 转账后所有人归零
      const after = new Map(balances);
      for (const t of transfers) {
        after.set(t.from, after.get(t.from)! + t.amount);
        after.set(t.to, after.get(t.to)! - t.amount);
      }
      expect([...after.values()].every((v) => v === 0)).toBe(true);
    }
  });

  it('忽略零余额成员', () => {
    const balances = new Map([
      ['a', 5000],
      ['b', -5000],
      ['c', 0],
    ]);

    const transfers = suggestTransfers(balances);

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toEqual({ from: 'b', to: 'a', amount: 5000 });
  });

  it('全部结清时没有任何建议', () => {
    expect(suggestTransfers(new Map([['a', 0], ['b', 0]]))).toEqual([]);
  });

  it('全额转账不会出现 0 元或负数笔', () => {
    const balances = new Map([
      ['a', 12345],
      ['b', -12345],
    ]);
    const transfers = suggestTransfers(balances);
    expect(transfers).toHaveLength(1);
    expect(transfers[0].amount).toBe(12345);
  });
});

describe('settle — 端到端组合', () => {
  it('从原始记录直接得出余额与结算建议', () => {
    const members = ['a', 'b', 'c'];
    const expenses: ExpenseRecord[] = [
      { id: 'e1', amount: 30000, paidBy: 'a' },
      { id: 'e2', amount: 6000, paidBy: 'b' },
    ];
    const shares = [...equalShares('e1', 30000, members), ...equalShares('e2', 6000, members)];

    const { balances, transfers } = settle(members, expenses, shares, []);

    expect(sumOf(balances)).toBe(0);
    expect(transfers.length).toBeLessThanOrEqual(2);

    // 按建议转账后，所有人归零
    const after = new Map(balances);
    for (const t of transfers) {
      after.set(t.from, after.get(t.from)! + t.amount);
      after.set(t.to, after.get(t.to)! - t.amount);
    }
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });
});

describe('随机模糊测试 —— 抓精度与守恒 bug', () => {
  // 确定性 PRNG，保证失败可复现
  function makeRng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('任意账目组合下，余额之和恒为 0 且结算建议可归零', () => {
    const rng = makeRng(20260912);

    for (let round = 0; round < 300; round++) {
      const memberCount = 2 + Math.floor(rng() * 5); // 2~6 人
      const members = Array.from({ length: memberCount }, (_, i) => `m${i}`);

      const expenses: ExpenseRecord[] = [];
      const shares: ShareRecord[] = [];
      const expenseCount = 1 + Math.floor(rng() * 8); // 1~8 笔

      for (let i = 0; i < expenseCount; i++) {
        const id = `e${i}`;
        // 1~100000 分（0.01 ~ 1000 元），刻意制造除不尽的金额
        const amount = 1 + Math.floor(rng() * 100000);
        const paidBy = members[Math.floor(rng() * memberCount)];
        expenses.push({ id, amount, paidBy });

        if (rng() < 0.5) {
          // 均摊
          for (const [memberId, shareAmount] of splitEqually(amount, members)) {
            shares.push({ expenseId: id, memberId, shareAmount });
          }
        } else {
          // 自定义分摊：随机切分，保证总和严格等于 amount
          let remaining = amount;
          members.forEach((memberId, idx) => {
            const isLast = idx === members.length - 1;
            const shareAmount = isLast ? remaining : Math.floor(rng() * (remaining + 1));
            remaining -= shareAmount;
            shares.push({ expenseId: id, memberId, shareAmount });
          });
        }
      }

      // 随机插入若干笔已结算转账
      const settlements: SettlementRecord[] = [];
      const settlementCount = Math.floor(rng() * 4);
      for (let i = 0; i < settlementCount; i++) {
        const fromMember = members[Math.floor(rng() * memberCount)];
        let toMember = members[Math.floor(rng() * memberCount)];
        if (fromMember === toMember) toMember = members[(members.indexOf(toMember) + 1) % memberCount];
        settlements.push({
          fromMember,
          toMember,
          amount: 1 + Math.floor(rng() * 50000),
        });
      }

      const balances = computeBalances(members, expenses, shares, settlements);

      // 守恒：整数分运算下必须严格为 0
      expect(sumOf(balances)).toBe(0);

      const transfers = suggestTransfers(balances);
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, memberCount - 1));
      expect(transfers.every((t) => Number.isInteger(t.amount) && t.amount > 0)).toBe(true);

      // 结算建议应用后必须完全归零
      const after = new Map(balances);
      for (const t of transfers) {
        after.set(t.from, after.get(t.from)! + t.amount);
        after.set(t.to, after.get(t.to)! - t.amount);
      }
      expect([...after.values()].every((v) => v === 0)).toBe(true);
    }
  });
});
