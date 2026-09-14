import { useEffect, useRef, useState } from 'react';
import { api, type Session } from '../api';
import { ErrorBanner } from '../App';
import Avatar, { AVATAR_PRESET_LIST } from './Avatar';
import InviteBox from './InviteBox';
import AccountSecurity from './AccountSecurity';
import PinForm from './PinForm';
import { useDismissable } from './useDismissable';

/**
 * 顶栏的「头像 + 姓名」按钮，点开是一个菜单，把原来散在顶栏和「室友」页
 * 里的几件事收到一起：
 *
 *   更换头像 / 切换房间（含新建·加入）/ 邀请新室友 / 修改密码 / 设置 PIN / 退出
 *
 * 用一个「子面板」而不是一堆跳转链接：这些都是小表单，跳走再回来反而绕。
 * `view` 是当前面板，`'menu'` 是根列表，返回键统一回到根。
 *
 * ⚠️ 这个组件**没有**用 `aria-modal` —— 它是个下拉菜单，不是模态框。
 *    所以 useDismissable 不锁焦点（锁了反而没法 Tab 到下一个控件），
 *    也不做遮罩层。
 */

type View = 'menu' | 'avatar' | 'rooms' | 'invite' | 'password' | 'pin';

export default function AvatarMenu({
  session,
  onSwitchHousehold,
  onOpenAddRoom,
  onSessionChanged,
  onLogout,
}: {
  session: Session;
  onSwitchHousehold: (householdId: string) => Promise<void>;
  onOpenAddRoom: () => void;
  /** 头像改完要重拉会话，顶栏和菜单里显示的头像才会跟着变。 */
  onSessionChanged: () => Promise<void>;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 关掉时把面板重置回根列表。不重置的话，下次打开还停在上次那一屏
  // （比如你刚改完密码，再点开直接是密码表单），看着像没关干净。
  function close() {
    setOpen(false);
    setView('menu');
    setError(null);
  }

  useDismissable({
    ref: panelRef,
    ignoreRef: triggerRef,
    onClose: close,
    closeOnOutsideClick: open,
  });

  // 换面板之后把焦点送回面板里。
  //
  // useDismissable 只在「打开」那一刻聚焦一次，它的依赖里没有 view；而点
  // 菜单项进子面板时，被点的那颗按钮已经卸载了——浏览器把焦点丢回 <body>，
  // 接下来按 Tab 是从整个页面开头重新走一遍，等于键盘用户每次进子面板都
  // 被弹回顶栏。
  //
  // 不能靠给面板加 key 重挂载来顺带解决：ref 对象的身份是稳定的，
  // 依赖没变，effect 不会重跑。
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button, input, [href]')?.focus();
  }, [view, open]);

  // ⚠️ 这里必须判空。`session.member` 在类型上可能是 null（「已登录但没选
  //    房间」那个中间态）。实际上 App 只在第三态才渲染顶栏，所以它不会是
  //    null——但类型系统不知道，而写 `!` 会把「万一哪天渲染条件放宽了」
  //    变成一个运行时崩溃。直接返回 null 更便宜。
  const me = session.member;
  if (!me) return null;

  const memberId = me.id;
  const households = session.households;
  const currentRoom = session.household;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const pickAvatar = (id: string | null) =>
    run(async () => {
      await api.setAvatar(memberId, id);
      await onSessionChanged();
      setView('menu');
    });

  return (
    <div className="avatar-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`avatar-trigger${open ? ' on' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar value={me.avatar} name={me.name} size={32} />
        <span className="avatar-trigger-name">{me.name}</span>
        <span className={`avatar-caret${open ? ' up' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="avatar-panel" ref={panelRef} role="menu">
          {view === 'menu' ? (
            <>
              <div className="avatar-panel-head">
                <Avatar value={me.avatar} name={me.name} size={44} />
                <div style={{ minWidth: 0 }}>
                  <div className="avatar-panel-name">{me.name}</div>
                  <div className="avatar-panel-mail">{session.account?.email}</div>
                </div>
              </div>

              <MenuItem icon="🎨" label="更换头像" onClick={() => setView('avatar')} />
              <MenuItem
                icon="🏠"
                label="切换房间"
                value={currentRoom?.name}
                onClick={() => setView('rooms')}
              />
              <MenuItem icon="✉️" label="邀请新室友" onClick={() => setView('invite')} />
              <MenuItem icon="🔑" label="修改密码" onClick={() => setView('password')} />
              <MenuItem icon="🔢" label="设置 PIN" onClick={() => setView('pin')} />

              <div className="avatar-menu-sep" />

              <button type="button" className="avatar-menu-item danger" onClick={onLogout}>
                <span className="avatar-menu-icon">↩︎</span>
                退出登录
              </button>
            </>
          ) : (
            <>
              <PanelHead title={PANEL_TITLES[view]} onBack={() => { setView('menu'); setError(null); }} />

              {/* 面板自己滚，不动顶栏和菜单头 */}
              <div className="avatar-panel-body">
                {view === 'avatar' && (
                  <>
                    <p className="small faint" style={{ marginTop: 0 }}>
                      挑一个。也可以选「不用头像」，用名字首字兜底。
                    </p>
                    <div className="avatar-grid">
                      {AVATAR_PRESET_LIST.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`avatar-pick${me.avatar === p.id ? ' on' : ''}`}
                          style={{ background: p.bg }}
                          disabled={busy}
                          onClick={() => void pickAvatar(p.id)}
                          aria-label={p.id}
                        >
                          {p.emoji}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-block"
                      disabled={busy || me.avatar === null}
                      onClick={() => void pickAvatar(null)}
                    >
                      不用头像（用名字首字）
                    </button>
                  </>
                )}

                {view === 'rooms' && (
                  <>
                    <p className="small faint" style={{ marginTop: 0 }}>
                      一个房间一个账本。切过去之后界面整个重挂载，不会把账记错地方。
                    </p>
                    <div className="member-grid">
                      {households.map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          className={`avatar-room${h.id === currentRoom?.id ? ' on' : ''}`}
                          disabled={busy || h.id === currentRoom?.id}
                          onClick={() =>
                            void run(async () => {
                              await onSwitchHousehold(h.id);
                              close();
                            })
                          }
                        >
                          <Avatar value={h.avatar} name={h.memberName} size={26} />
                          <span style={{ minWidth: 0 }}>
                            <span className="avatar-room-name">{h.name}</span>
                            <span className="chip-sub">
                              {h.memberName}
                              {h.room ? ` · ${h.room}` : ''}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                    <ErrorBanner error={error} />
                    <button
                      type="button"
                      className="btn btn-ghost btn-block"
                      onClick={() => {
                        onOpenAddRoom();
                        close();
                      }}
                    >
                      ＋ 新建 / 用邀请码加入房间
                    </button>
                  </>
                )}

                {view === 'invite' && currentRoom && (
                  <InviteBox code={currentRoom.inviteCode} householdName={currentRoom.name} />
                )}

                {view === 'password' && <AccountSecurity embedded />}

                {view === 'pin' && <PinForm />}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PANEL_TITLES: Record<Exclude<View, 'menu'>, string> = {
  avatar: '更换头像',
  rooms: '切换房间',
  invite: '邀请新室友',
  password: '修改密码',
  pin: '设置 PIN',
};

function MenuItem({
  icon,
  label,
  value,
  onClick,
}: {
  icon: string;
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="avatar-menu-item" onClick={onClick} role="menuitem">
      <span className="avatar-menu-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="avatar-menu-label">{label}</span>
      {value && <span className="avatar-menu-value">{value}</span>}
      <span className="avatar-menu-arrow" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function PanelHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="avatar-panel-head bar">
      <button type="button" className="link" onClick={onBack}>
        ‹ 返回
      </button>
      <span className="avatar-panel-title">{title}</span>
      {/* 占位，让标题真正居中 */}
      <span style={{ width: 32 }} />
    </div>
  );
}
