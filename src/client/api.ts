import type { ErrorCode } from '../shared/errors';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint?: string,
    public code?: ErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 响应（例如 Cloudflare 返回的错误页）
      if (!res.ok) throw new ApiError(res.status, `请求失败（HTTP ${res.status}）`);
      throw new ApiError(res.status, '服务器返回了无法解析的内容');
    }
  }

  if (!res.ok) {
    const body = (payload ?? {}) as { error?: string; hint?: string; code?: ErrorCode };

    // 会话失效 / 失去房间成员身份时广播事件，由 App 统一处理。
    // 放在这里而不是每个页面各自判断，避免漏掉某一处后界面卡在半死不活的状态。
    //
    // ⚠️ 这两种情况必须分开：NO_MEMBERSHIP 是「登录着，但当前房间下没有身份」
    //    （还没选房间，或已从该房间退租），**不能**当成会话过期把人踢回登录页——
    //    他会重登一次然后re-进入同样的状态，永远出不来。正确做法是让他回到
    //    房间选择页，在那里建房或加入。
    //
    //    也不能只看 HTTP 状态码：两者都可能是 401/403，只有 code 能区分。
    //    判断放在 code 缺失时的兜底上（老服务端只会返回 401 无 code）。
    if (!path.startsWith('/auth/')) {
      if (body.code === 'NO_MEMBERSHIP') {
        window.dispatchEvent(new CustomEvent('hzm:no-membership'));
      } else if (res.status === 401 || body.code === 'SESSION_EXPIRED') {
        window.dispatchEvent(new CustomEvent('hzm:unauthorized'));
      }
    }

    throw new ApiError(
      res.status,
      body.error ?? `请求失败（HTTP ${res.status}）`,
      body.hint,
      body.code,
    );
  }

  return payload as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

// ── 类型 ──────────────────────────────────────────────────────────

export interface Household {
  id: string;
  name: string;
  inviteCode: string;
}

export interface Member {
  id: string;
  name: string;
  room: string | null;
  phone: string | null;
  moveIn: number | null;
  moveOut: number | null;
  isActive: boolean;
  hasPin: boolean;
}

export interface ExpenseShare {
  memberId: string;
  shareAmount: number;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: string;
  paidBy: string;
  paidByName: string;
  spentOn: number;
  splitType: string;
  note: string | null;
  createdAt: number;
  shares: ExpenseShare[];
}

export interface BalanceEntry {
  memberId: string;
  name: string;
  isActive: boolean;
  amount: number;
}

export interface Transfer {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
}

export interface Settlement {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  amount: number;
  settledOn: number;
  note: string | null;
}

export interface Chore {
  id: string;
  name: string;
  cycle: string;
  weekday: number | null;
  memberIds: string[];
  isActive: boolean;
  currentAssignee: { id: string; name: string } | null;
  periodStart: number | null;
  doneAt: number | null;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  authorId: string;
  authorName: string;
  createdAt: number;
}

export interface Item {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  minQuantity: number;
  note: string | null;
  updatedAt: number;
  needsRestock: boolean;
}

export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
}

/** 账号在某个房间里的身份，用于房间切换列表。 */
export interface HouseholdSummary {
  id: string;
  name: string;
  inviteCode: string;
  memberId: string;
  memberName: string;
  room: string | null;
}

export interface MemberIdentity {
  id: string;
  name: string;
  room: string | null;
  phone: string | null;
}

/**
 * /auth/me 的返回。
 *
 * 这是重构前那个 Session 的**超集**：`household` / `member` 的形状一字未改，
 * 只是现在可能为 null（账号已登录但还没选房间，或已从当前房间退租）。
 *
 * 下面那个 ActiveSession 把两者收窄成非空，页面组件只接触它——所以
 * 7 个页面里 15 处 `session.member.id` 在重构后一行都不用改。
 */
export interface Session {
  account: Account | null;
  households: HouseholdSummary[];
  household: Household | null;
  member: MemberIdentity | null;
}

/** 已经选好房间、可以正常使用的登录态。 */
export type ActiveSession = Session & { household: Household; member: MemberIdentity };

// ── 认证 ──────────────────────────────────────────────────────────

/** 注册返回里带的恢复码明文。**只有这一次**，之后数据库里只有哈希。 */
export interface WithRecoveryCodes {
  recoveryCodes?: string[];
}

export const api = {
  health: () => request<{ ok: boolean }>('/health'),

  // ── 账号 ────────────────────────────────────────────────────────
  register: (body: { email: string; password: string }) =>
    request<Session & WithRecoveryCodes>('/auth/register', { method: 'POST', ...json(body) }),

  loginWithPassword: (body: { email: string; password: string }) =>
    request<Session>('/auth/login', { method: 'POST', ...json(body) }),

  /** 邀请码 + 我是谁 + PIN 的快捷登录。要求该身份已经绑定账号。 */
  loginWithPin: (body: { inviteCode: string; memberId: string; pin: string }) =>
    request<Session>('/auth/login/pin', { method: 'POST', ...json(body) }),

  switchHousehold: (householdId: string) =>
    request<Session>('/auth/switch', { method: 'POST', ...json({ householdId }) }),

  /** 改密码第一步：验证当前密码，5 分钟内有效。 */
  verifyPassword: (password: string) =>
    request<{ ok: boolean; expiresInMs: number }>('/auth/password/verify', {
      method: 'POST',
      ...json({ password }),
    }),

  /** 改密码第二步：设置新密码。必须先通过 verifyPassword。 */
  changePassword: (newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', { method: 'POST', ...json({ newPassword }) }),

  /** 用恢复码重置密码（忘记密码时的自助途径），会清空所有登录态。 */
  resetWithRecoveryCode: (body: { email: string; code: string; newPassword: string }) =>
    request<{ ok: boolean }>('/auth/recovery', { method: 'POST', ...json(body) }),

  /** 重设恢复码，需要提供当前密码。旧的一批立即作废。 */
  regenerateRecoveryCodes: (password: string) =>
    request<{ recoveryCodes: string[] }>('/auth/recovery-codes', {
      method: 'POST',
      ...json({ password }),
    }),

  // ── 房间 ────────────────────────────────────────────────────────
  //
  // createHousehold 和 join 支持两种调用方式：
  //   - 匿名：body 里带 email + password，会顺带把账号建出来
  //   - 已登录：不带邮箱密码，凭 cookie 直接开第二个房间（不消耗 PBKDF2）

  createHousehold: (body: {
    householdName: string;
    memberName: string;
    room?: string;
    email?: string;
    password?: string;
  }) =>
    request<Session & WithRecoveryCodes>('/auth/household', { method: 'POST', ...json(body) }),

  lookupHousehold: (code: string) =>
    request<{
      household: { id: string; name: string };
      members: { id: string; name: string; claimed: boolean }[];
    }>(`/auth/household/${encodeURIComponent(code)}`),

  join: (body: {
    inviteCode: string;
    name: string;
    room?: string;
    claimMemberId?: string;
    email?: string;
    password?: string;
  }) => request<Session & WithRecoveryCodes>('/auth/join', { method: 'POST', ...json(body) }),

  /** 设置 / 修改当前房间里的 PIN。已有 PIN 时必须先提供 currentPin。 */
  setPin: (body: { pin: string; currentPin?: string }) =>
    request<{ ok: boolean }>('/auth/pin', { method: 'POST', ...json(body) }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<Session>('/auth/me'),

  // ── 成员 ────────────────────────────────────────────────────────
  listMembers: () => request<{ members: Member[] }>('/members'),

  addMember: (body: { name: string; room?: string; phone?: string }) =>
    request<{ member: Member }>('/members', { method: 'POST', ...json(body) }),

  updateMember: (id: string, body: Partial<{ name: string; room: string; phone: string }>) =>
    request<{ ok: boolean }>(`/members/${id}`, { method: 'PATCH', ...json(body) }),

  leaveMember: (id: string) => request<{ ok: boolean }>(`/members/${id}/leave`, { method: 'POST' }),
  restoreMember: (id: string) => request<{ ok: boolean }>(`/members/${id}/restore`, { method: 'POST' }),

  // 改 PIN 已迁到 api.setPin（POST /api/auth/pin）——它作用在「当前房间里的
  // 自己」身上，不再需要传成员 id。

  // ── 账目 ────────────────────────────────────────────────────────
  listExpenses: (params: { limit?: number; offset?: number; category?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    if (params.category) qs.set('category', params.category);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ total: number; limit: number; offset: number; expenses: Expense[] }>(
      `/expenses${suffix}`,
    );
  },

  createExpense: (body: {
    title: string;
    amount: number;
    category: string;
    paidBy: string;
    spentOn?: number;
    splitType: string;
    memberIds?: string[];
    shares?: ExpenseShare[];
    note?: string;
  }) => request<{ expense: Expense }>('/expenses', { method: 'POST', ...json(body) }),

  updateExpense: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/expenses/${id}`, { method: 'PATCH', ...json(body) }),

  deleteExpense: (id: string) => request<{ ok: boolean }>(`/expenses/${id}`, { method: 'DELETE' }),

  // ── 余额与结算 ──────────────────────────────────────────────────
  balances: () => request<{ balances: BalanceEntry[]; transfers: Transfer[] }>('/balance'),

  listSettlements: (params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ total: number; settlements: Settlement[] }>(`/balance/settlements${suffix}`);
  },

  createSettlement: (body: { from: string; to: string; amount: number; note?: string }) =>
    request<{ settlement: Settlement }>('/balance/settlements', { method: 'POST', ...json(body) }),

  deleteSettlement: (id: string) =>
    request<{ ok: boolean }>(`/balance/settlements/${id}`, { method: 'DELETE' }),

  // ── 值日 ────────────────────────────────────────────────────────
  listChores: () => request<{ chores: Chore[] }>('/chores'),

  createChore: (body: { name: string; cycle: string; memberIds: string[] }) =>
    request<{ chore: Chore }>('/chores', { method: 'POST', ...json(body) }),

  updateChore: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/chores/${id}`, { method: 'PATCH', ...json(body) }),

  deleteChore: (id: string) => request<{ ok: boolean }>(`/chores/${id}`, { method: 'DELETE' }),

  completeChore: (id: string) => request<{ ok: boolean }>(`/chores/${id}/complete`, { method: 'POST' }),

  // ── 公告 ────────────────────────────────────────────────────────
  listAnnouncements: () => request<{ announcements: Announcement[] }>('/announcements'),

  createAnnouncement: (body: { title: string; content: string; isPinned?: boolean }) =>
    request<{ announcement: Announcement }>('/announcements', { method: 'POST', ...json(body) }),

  updateAnnouncement: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/announcements/${id}`, { method: 'PATCH', ...json(body) }),

  deleteAnnouncement: (id: string) =>
    request<{ ok: boolean }>(`/announcements/${id}`, { method: 'DELETE' }),

  // ── 公共物品 ────────────────────────────────────────────────────
  listItems: () => request<{ items: Item[] }>('/items'),

  createItem: (body: { name: string; quantity?: number; unit?: string; minQuantity?: number; note?: string }) =>
    request<{ item: Item }>('/items', { method: 'POST', ...json(body) }),

  updateItem: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/items/${id}`, { method: 'PATCH', ...json(body) }),

  deleteItem: (id: string) => request<{ ok: boolean }>(`/items/${id}`, { method: 'DELETE' }),
};
