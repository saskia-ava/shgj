import { centsToYuan, yuanToCents } from '../shared/money';

/** 「分」→ 显示用金额。负号放在 ¥ 前面，`-¥5.50` 比 `¥-5.50` 好读。 */
export function fmtMoney(cents: number): string {
  const abs = centsToYuan(Math.abs(cents));
  return cents < 0 ? `-¥${abs}` : `¥${abs}`;
}

/** 带正负号的金额，用于余额列表。 */
export function fmtSigned(cents: number): string {
  if (cents === 0) return '¥0.00';
  return `${cents > 0 ? '+' : '−'}¥${centsToYuan(Math.abs(cents))}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 时间戳 → `2026-09-12` */
export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 时间戳 → `09-12 15:30` */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 时间戳 → `今天` / `昨天` / `09-12` */
export function fmtRelativeDate(ts: number): string {
  const target = new Date(ts);
  target.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  return fmtDate(ts).slice(5);
}

/** 时间戳 → `<input type="date">` 需要的 `2026-09-12` */
export function toDateInput(ts: number): string {
  return fmtDate(ts);
}

/** `<input type="date">` 的值 → 时间戳（当天中午，避开时区把日期挪一天） */
export function fromDateInput(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return Date.now();
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

/** 用户输入的「元」转成「分」，格式错误返回 null 而不是抛错。 */
export function parseMoneyInput(value: string): number | null {
  try {
    const cents = yuanToCents(value);
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

/** 周期标签 */
export const CYCLE_LABEL: Record<string, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
};

/** 分类的固定顺序，和 worker 端保持一致 */
export const CATEGORIES = ['房租', '水电', '燃气', '网费', '日用', '维修', '其他'] as const;

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
