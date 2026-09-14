import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, ApiError, type ActiveSession, type Member, type Session } from './api';
import AuthPage from './pages/AuthPage';
import HouseholdGate from './pages/HouseholdGate';
import { CreateHouseholdForm, JoinHouseholdForm } from './pages/HouseholdForms';
import Dashboard from './pages/Dashboard';
import Expenses from './pages/Expenses';
import Balance from './pages/Balance';
import Chores from './pages/Chores';
import Announcements from './pages/Announcements';
import Items from './pages/Items';
import Members from './pages/Members';

export interface AppContextValue {
  /**
   * ⚠️ 类型是 ActiveSession（household / member 保证非空），不是 Session。
   *    「已登录但没选房间」这个中间态被挡在 Provider 之外，所以页面组件里
   *    可以放心写 session.member.id，不需要到处判空。
   */
  session: ActiveSession;
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
  const [addRoomOpen, setAddRoomOpen] = useState(false);

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

  // 切到别的房间时只刷新会话，不清 members——members 会由下面那个
  // 「session 变了就重拉」的 effect 负责，避免两处同时改状态。
  const switchHousehold = useCallback(async (householdId: string) => {
    const me = await api.switchHousehold(householdId);
    setSession(me);
  }, []);

  const closeAddRoom = useCallback(() => setAddRoomOpen(false), []);

  // 建完 / 加入完房间之后：**先重拉会话，再关弹窗**。
  //
  // ⚠️ 两件事的顺序不能换，也不能省掉关闭这一句：
  //    - `key={householdId}` 只覆盖 Provider 的子树，App 自己没被覆盖，
  //      所以切房间**不会**把 addRoomOpen 重置回 false。少了这句，用户建完
  //      房间会看到弹窗还杵在那儿，里面是一张已经提交过的空表单。
  //    - 反过来先关再拉的话，`api.me()` 万一失败，错误会被渲染到一个已经
  //      卸载的表单里——用户什么都看不到，只觉得「点了没反应」。
  const finishAddRoom = useCallback(async () => {
    await reloadSession();
    setAddRoomOpen(false);
  }, [reloadSession]);

  // 多标签页共享同一个 cookie：在 A 标签页切了房间，B 标签页并不知道，
  // 会继续往记忆中的旧房间写数据。这里在标签页重新可见时对一次账，
  // 发现当前房间变了就同步过来。
  //
  // 这只解决了「切回来的时候能发现」，切过去的瞬间仍可能写错一两条。
  // 彻底解决需要跨标签页通信，成本远大于收益。README 里把它列为已知限制。
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    const syncIfChanged = async () => {
      if (document.visibilityState !== 'visible') return;
      const current = sessionRef.current;
      if (!current) return; // 未登录时不折腾

      try {
        const me = await api.me();
        // 只在「当前房间或身份真的变了」时才更新，否则每次切标签页都会
        // 触发一轮全量刷新
        if (me.household?.id !== current.household?.id || me.member?.id !== current.member?.id) {
          setSession(me);
        }
      } catch {
        // 网络问题或会话已失效。失效的情况由各请求自己的 401 处理兜底。
      }
    };

    document.addEventListener('visibilitychange', syncIfChanged);
    window.addEventListener('focus', syncIfChanged);
    return () => {
      document.removeEventListener('visibilitychange', syncIfChanged);
      window.removeEventListener('focus', syncIfChanged);
    };
  }, []);

  const activeMembers = useMemo(() => members.filter((m) => m.isActive), [members]);

  const nameOf = useCallback(
    (id: string) => members.find((m) => m.id === id)?.name ?? '未知成员',
    [members],
  );

  // 三态里的第三态：会话、房间、身份三者齐全，才能进主界面
  const activeSession: ActiveSession | null =
    session && session.household && session.member
      ? (session as ActiveSession)
      : null;
  const householdId = activeSession?.household.id ?? null;

  const ctxValue: AppContextValue | null = useMemo(
    () =>
      activeSession
        ? {
            session: activeSession,
            members,
            activeMembers,
            nameOf,
            reloadMembers,
            reloadSession,
            logout,
          }
        : null,
    [activeSession, members, activeMembers, nameOf, reloadMembers, reloadSession, logout],
  );

  if (booting) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在加载…
      </div>
    );
  }

  // 第一态：没登录
  if (!session) {
    return <AuthPage onAuthed={reloadSession} />;
  }

  // 第二态：登录了，但当前房间下没有身份（还没选房间，或已从该房间退租）
  if (!activeSession || !ctxValue) {
    return <HouseholdGate session={session} onChanged={reloadSession} onLogout={logout} />;
  }

  return (
    // ⚠️ key={householdId} 是这里性价比最高的一行：切换房间时整个子树会被
    //    卸载重建，所有页面组件里的 useState 全部归零。没有它就会出现
    //    「切到 B 房了，记账页还预填着 A 房的成员和分类」这类静默写错房间的
    //    bug——而且不会报错，只会把数据写到看不见的地方去。
    <AppContext.Provider value={ctxValue} key={householdId}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-inner">
            <div style={{ minWidth: 0 }}>
              <h1>{activeSession.household.name}</h1>
              <div className="topbar-sub">
                你好，{activeSession.member.name}
                {activeSession.member.room ? ` · ${activeSession.member.room}` : ''}
              </div>
            </div>
            <div className="topbar-actions">
              {session.households.length > 1 && (
                <label className="household-switch">
                  <span className="sr-only">切换房间</span>
                  <select
                    value={activeSession.household.id}
                    onChange={(e) => void switchHousehold(e.target.value)}
                  >
                    {session.households.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* ⚠️ 这个按钮和上面的下拉框是**互补**的，两个条件不能混：
                  下拉框只在 `households.length > 1` 时出现（一个房间没什么好切的），
                  而建第二个房间恰恰要在一个房间的时候才能做。
                  曾经只有下拉框没有这个按钮，结果是——只有一个房间的账号，
                  界面上没有任何入口能建/加入第二个房间，只能退出登录重新注册。
                  服务端一直支持（见 HouseholdForms.tsx 顶部注释）。 */}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setAddRoomOpen(true)}
              >
                ＋ 房间
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                退出
              </button>
            </div>
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
          {/* 会话过期 / 失去房间身份时统一在这里兜底，避免每个页面各写一遍 */}
          <SessionExpiryGuard onExpired={logout} onNoMembership={reloadSession} />

          {tab === 'dashboard' && <Dashboard onNavigate={(key) => setTab(key as TabKey)} />}
          {tab === 'expenses' && <Expenses />}
          {tab === 'balance' && <Balance />}
          {tab === 'chores' && <Chores />}
          {tab === 'announcements' && <Announcements />}
          {tab === 'items' && <Items />}
          {tab === 'members' && <Members />}
        </main>
      </div>

      {/* 放在 Provider 里、.app 外面：切房间时 key 变化会把它一起重建，
          弹窗里「新建 / 加入」的选择状态跟着归零，下次打开是干净的。 */}
      {addRoomOpen && <AddRoomModal onClose={closeAddRoom} onDone={finishAddRoom} />}
    </AppContext.Provider>
  );
}

/**
 * 「＋ 房间」弹窗。
 *
 * 这是给**已经有房间**的人准备的第二入口：新建一个房间，或者用邀请码加入
 * 别人的房间。两种情况下服务端都会把会话的 active_household_id 切到新房间
 * 并返回新 payload（auth.ts:541 / auth.ts:671），所以提交完直接落进新房间，
 * 不需要额外来一步「切换」。
 *
 * ⚠️ 这个按钮以前不存在，于是「同一个人怎么用第二个房间」在界面上是无解的。
 *    没做权限判断是**故意**的：多房间一开始就是设计目标（一个房间一个账本），
 *    服务端也早就按账号可以属于多个房间来建模了，这里只是把入口补上。
 */
function AddRoomModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    // 打开时把焦点移进弹窗。不做的话键盘用户按 Tab 会跑到后面那层被遮住的
    // 页面上，而视觉上完全看不出焦点在哪儿。
    card.focus();

    const onKey = (e: KeyboardEvent) => {
      // Esc 关闭。遮罩点击只是补充——键盘用户没有别的办法出去。
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // 把焦点锁在弹窗里。
      // ⚠️ 这不是可选的润色：下面写了 `aria-modal="true"`，那句话断言的是
      //    「弹窗外面不可交互」。不锁的话这个断言就是假的——屏幕阅读器把
      //    后面那层读成不可用，键盘却进得去。要么两者都有，要么两者都没有。
      const nodes = card.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      );
      // 过滤掉 disabled 的：建房表单在房间名/名字填完前，提交按钮是禁用的，
      // 不滤的话「最后一个可聚焦元素」会算到一个根本聚焦不上的按钮上。
      const focusable = Array.from(nodes).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === card)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      // 点遮罩关闭。里面的卡片必须吃掉冒泡，否则在输入框里按下鼠标、
      // 拖到卡片外面再松手，也会顺手把弹窗关掉并丢掉填了一半的内容。
    >
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-room-title"
        // tabIndex={-1} 是为了能 .focus()（上面那个 effect），但不进 Tab 序列。
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="add-room-title">
            再开一个房间
          </h2>
          <button type="button" className="link faint" onClick={onClose}>
            关闭
          </button>
        </div>

        <p className="auth-desc" style={{ textAlign: 'left', marginBottom: 16 }}>
          一个房间一个账本。新建或加入之后会自动切过去，之后在顶栏随时切回来。
        </p>

        {/* 两个表单是**不同类型**的组件，React 在同一个位置遇到类型变化会
            卸载重建，各自的 useState（名字、邀请码、查到的一半状态）天然
            互不串台，不需要额外给 key。 */}
        <div className="segmented" style={{ marginBottom: 18 }}>
          <button
            type="button"
            className={`seg${mode === 'create' ? ' on' : ''}`}
            onClick={() => setMode('create')}
          >
            新建房间
          </button>
          <button
            type="button"
            className={`seg${mode === 'join' ? ' on' : ''}`}
            onClick={() => setMode('join')}
          >
            用邀请码加入
          </button>
        </div>

        {mode === 'create' ? (
          <CreateHouseholdForm onDone={onDone} />
        ) : (
          <JoinHouseholdForm onDone={onDone} />
        )}
      </div>
    </div>
  );
}

/**
 * 登录态失效兜底。两个事件分别处理，**不能合并**：
 *
 *   hzm:unauthorized  —— 会话真失效了（过期、被清理、换了设备）。退回登录页，
 *                        并且要把本地状态清干净（走 logout 而不是只 reload）。
 *   hzm:no-membership —— 登录着，但当前房间下没有身份了。这时**千万不能**
 *                        退回登录页：用户重登一次会回到完全一样的状态，
 *                        永远出不来。正确做法是重新拉一次 /me，让 App
 *                        渲染出房间选择页。
 */
function SessionExpiryGuard({
  onExpired,
  onNoMembership,
}: {
  onExpired: () => void;
  onNoMembership: () => void;
}) {
  useEffect(() => {
    const expired = () => void onExpired();
    const noMembership = () => void onNoMembership();

    window.addEventListener('hzm:unauthorized', expired);
    window.addEventListener('hzm:no-membership', noMembership);
    return () => {
      window.removeEventListener('hzm:unauthorized', expired);
      window.removeEventListener('hzm:no-membership', noMembership);
    };
  }, [onExpired, onNoMembership]);
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
