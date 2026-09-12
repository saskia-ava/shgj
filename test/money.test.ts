import { describe, it, expect } from 'vitest';
import { yuanToCents, centsToYuan, splitEqually, sharesSumTo } from '../src/shared/money';

describe('yuanToCents', () => {
  it('解析整数元', () => {
    expect(yuanToCents('100')).toBe(10000);
    expect(yuanToCents(100)).toBe(10000);
    expect(yuanToCents('0')).toBe(0);
  });

  it('解析一位和两位小数', () => {
    expect(yuanToCents('100.5')).toBe(10050);
    expect(yuanToCents('100.55')).toBe(10055);
    expect(yuanToCents('0.01')).toBe(1);
    expect(yuanToCents('0.1')).toBe(10);
  });

  it('解析负数（退款场景）', () => {
    expect(yuanToCents('-5.5')).toBe(-550);
  });

  it('避开浮点误差——这正是不用 parseFloat 的原因', () => {
    // parseFloat('0.29') * 100 === 28.999999999999996
    expect(yuanToCents('0.29')).toBe(29);
    expect(yuanToCents('1.15')).toBe(115);
    expect(yuanToCents('8.11')).toBe(811);
    expect(yuanToCents('35.35')).toBe(3535);
  });

  it('拒绝非法格式', () => {
    expect(() => yuanToCents('abc')).toThrow();
    expect(() => yuanToCents('1.234')).toThrow(); // 超过两位小数
    expect(() => yuanToCents('')).toThrow();
    expect(() => yuanToCents('1,000')).toThrow();
  });
});

describe('centsToYuan', () => {
  it('固定两位小数', () => {
    expect(centsToYuan(10000)).toBe('100.00');
    expect(centsToYuan(1)).toBe('0.01');
    expect(centsToYuan(1050)).toBe('10.50');
    expect(centsToYuan(0)).toBe('0.00');
    expect(centsToYuan(-550)).toBe('-5.50');
  });

  it('拒绝非整数分', () => {
    expect(() => centsToYuan(1.5)).toThrow();
  });

  it('往返转换不丢精度', () => {
    for (const raw of ['0.01', '0.29', '1.15', '8.11', '35.35', '99999.99']) {
      expect(centsToYuan(yuanToCents(raw))).toBe(Number(raw).toFixed(2));
    }
  });
});

describe('splitEqually', () => {
  it('整除时每人金额相同', () => {
    const shares = splitEqually(10000, ['a', 'b', 'c', 'd']);
    expect([...shares.values()]).toEqual([2500, 2500, 2500, 2500]);
  });

  it('除不尽时总和一分不差，且每人差额不超过 1 分', () => {
    // 100 元 ÷ 3 人 = 33.33 元，余 1 分
    const shares = splitEqually(10000, ['a', 'b', 'c']);
    const values = [...shares.values()];

    expect(values.reduce((x, y) => x + y, 0)).toBe(10000);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    expect(values).toEqual([3334, 3333, 3333]);
  });

  it('余数分给靠前的成员，且可复现', () => {
    const first = splitEqually(100, ['a', 'b', 'c']);
    const second = splitEqually(100, ['a', 'b', 'c']);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect([...first.values()].reduce((x, y) => x + y, 0)).toBe(100);
  });

  it('1 分钱分给 3 人不会丢钱', () => {
    const shares = splitEqually(1, ['a', 'b', 'c']);
    expect([...shares.values()]).toEqual([1, 0, 0]);
    expect([...shares.values()].reduce((x, y) => x + y, 0)).toBe(1);
  });

  it('负数（退款）也能平分干净', () => {
    const shares = splitEqually(-10000, ['a', 'b', 'c']);
    expect([...shares.values()].reduce((x, y) => x + y, 0)).toBe(-10000);
  });

  it('没有成员时报错', () => {
    expect(() => splitEqually(10000, [])).toThrow();
  });

  it('拒绝非整数分', () => {
    expect(() => splitEqually(100.5, ['a', 'b'])).toThrow();
  });

  it('大额与多人压力测试——总和恒等于总额', () => {
    for (let people = 1; people <= 20; people++) {
      const ids = Array.from({ length: people }, (_, i) => `m${i}`);
      for (const total of [1, 7, 99, 12345, 99999999, 123456789]) {
        const shares = splitEqually(total, ids);
        expect([...shares.values()].reduce((x, y) => x + y, 0)).toBe(total);
      }
    }
  });
});

describe('sharesSumTo', () => {
  it('校验分摊总额', () => {
    expect(sharesSumTo(10000, [{ shareAmount: 3334 }, { shareAmount: 3333 }, { shareAmount: 3333 }])).toBe(true);
    expect(sharesSumTo(10000, [{ shareAmount: 5000 }, { shareAmount: 4999 }])).toBe(false);
  });
});
