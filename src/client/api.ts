export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint?: string,
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
    // 会话失效时广播一个事件，由 App 统一退回登录页。
    // 放在这里而不是每个页面各自判断，避免漏掉某一处后界面卡在半死不活的状态。
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('hzm:unauthorized'));
    }

    const body = (payload ?? {}) as { error?: string; hint?: string };
    throw new ApiError(res.status, body.error ?? `请求失败（HTTP ${res.status}）`, body.hint);
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

export interface Session {
  household: Household;
  member: { id: string; name: string; room: string | null; phone: string | null };
}

// ── 认证 ──────────────────────────────────────────────────────────

export const api = {
  health: () => request<{ ok: boolean }>('/health'),

  createHousehold: (body: { householdName: string; memberName: string; room?: string; pin: string }) =>
    request<{ household: Household; member: { id: string; name: string } }>(
      '/auth/household',
      { method: 'POST', ...json(body) },
    ),

  lookupHousehold: (code: string) =>
    request<{
      household: { id: string; name: string };
      members: { id: string; name: string; hasPin: boolean }[];
    }>(`/auth/household/${encodeURIComponent(code)}`),

  join: (body: { inviteCode: string; name: string; room?: string; pin: string }) =>
    request<{ household: Household; member: { id: string; name: string } }>('/auth/join', {
      method: 'POST',
      ...json(body),
    }),

  login: (body: { inviteCode: string; memberId: string; pin: string }) =>
    request<{ member: { id: string; name: string } }>('/auth/login', { method: 'POST', ...json(body) }),

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

  changePin: (id: string, body: { oldPin?: string; newPin: string }) =>
    request<{ ok: boolean }>(`/members/${id}/pin`, { method: 'POST', ...json(body) }),

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
