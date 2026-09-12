import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Member, type Session } from './api';
import AuthPage from './pages/AuthPage';
import Dashboard from './pages/Dashboard';
import Expenses from './pages/Expenses';
import Balance from './pages/Balance';
import Chores from './pages/Chores';
import Announcements from './pages/Announcements';
import Items from './pages/Items';
import Members from './pages/Members';

export interface AppContextValue {
  session: Session;
  members: Member[];
  activeMembers: Member[];
  nameOf: (id: string) => string;
  reloadMembers: () => Promise<void>;
  reloadSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppContext 内使用');
  return ctx;
}

type TabKey = 'dashboard' | 'expenses' | 'balance' | 'chores' | 'announcements' | 'items' | 'members';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: '总览' },
  { key: 'expenses', label: '记账' },
  { key: 'balance', label: '结算' },
  { key: 'chores', label: '值日' },
  { key: 'announcements', label: '公告' },
  { key: 'items', label: '物品' },
  { key: 'members', label: '室友' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [restockCount, setRestockCount] = useState(0);
  const [openChoreCount, setOpenChoreCount] = useState(0);

  const reloadSession = useCallback(async () => {
    const me = await api.me();
    setSession(me);
  }, []);

  const reloadMembers = useCallback(async () => {
    const { members: list } = await api.listMembers();
    setMembers(list);
  }, []);

  // 启动时尝试恢复会话：cookie 还在就直接进主界面
  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setSession(me);
      } catch {
        // 未登录是正常状态，不是错误
        setSession(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (session) void reloadMembers();
  }, [session, reloadMembers]);

  // 侧边角标：待补货物品数、本周未完成的值日数。
  // 失败时静默忽略——角标不值得打断用户。
  const refreshBadges = useCallback(async () => {
    if (!session) return;
    try {
      const [{ items }, { chores }] = await Promise.all([api.listItems(), api.listChores()]);
      setRestockCount(items.filter((i) => i.needsRestock).length);
      setOpenChoreCount(chores.filter((c) => c.isActive && !c.doneAt).length);
    } catch {
      /* 忽略 */
    }
  }, [session]);

  useEffect(() => {
    void refreshBadges();
  }, [refreshBadges, tab]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSession(null);
      setMembers([]);
      setTab('dashboard');
    }
  }, []);

  const activeMembers = useMemo(() => members.filter((m) => m.isActive), [members]);

  const nameOf = useCallback(
    (id: string) => members.find((m) => m.id === id)?.name ?? '未知成员',
    [members],
  );

  const ctxValue: AppContextValue | null = useMemo(
    () =>
      session
        ? { session, members, activeMembers, nameOf, reloadMembers, reloadSession, logout }
        : null,
    [session, members, activeMembers, nameOf, reloadMembers, reloadSession, logout],
  );

  if (booting) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在加载…
      </div>
    );
  }

  if (!session || !ctxValue) {
    return (
      <AuthPage
        onAuthed={async () => {
          await reloadSession();
        }}
      />
    );
  }

  return (
    <AppContext.Provider value={ctxValue}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-inner">
            <div style={{ minWidth: 0 }}>
              <h1>{session.household.name}</h1>
              <div className="topbar-sub">
                你好，{session.member.name}
                {session.member.room ? ` · ${session.member.room}` : ''}
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
              退出
            </button>
          </div>

          <nav className="tabs">
            {TABS.map((t) => {
              const badge =
                t.key === 'items' ? restockCount : t.key === 'chores' ? openChoreCount : 0;
              return (
                <button
                  key={t.key}
                  type="button"
                  className={`tab${tab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                  {badge > 0 && <span className="badge">{badge}</span>}
                </button>
              );
            })}
          </nav>
        </header>

        <main className="main">
          {/* 会话过期时（例如服务器重启或清理了会话表）统一在这里兜底，
              避免每个页面各写一遍 401 处理 */}
          <SessionExpiryGuard onExpired={logout} />

          {tab === 'dashboard' && <Dashboard onNavigate={(key) => setTab(key as TabKey)} />}
          {tab === 'expenses' && <Expenses />}
          {tab === 'balance' && <Balance />}
          {tab === 'chores' && <Chores />}
          {tab === 'announcements' && <Announcements />}
          {tab === 'items' && <Items />}
          {tab === 'members' && <Members />}
        </main>
      </div>
    </AppContext.Provider>
  );
}

/**
 * 会话失效兜底。
 *
 * 各页面的请求如果返回 401，说明 cookie 已失效（过期、被清理、或换了设备）。
 * 这里监听一个全局事件，统一退回登录页，而不是让每个页面各自处理。
 */
function SessionExpiryGuard({ onExpired }: { onExpired: () => void }) {
  useEffect(() => {
    const handler = () => void onExpired();
    window.addEventListener('hzm:unauthorized', handler);
    return () => window.removeEventListener('hzm:unauthorized', handler);
  }, [onExpired]);
  return null;
}

/** 页面通用的错误提示组件。 */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;

  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : '发生了未知错误';

  const hint = error instanceof ApiError ? error.hint : undefined;

  return (
    <div className="alert alert-error">
      <div>
        <div>{message}</div>
        {hint && <div className="alert-hint">{hint}</div>}
      </div>
    </div>
  );
}
