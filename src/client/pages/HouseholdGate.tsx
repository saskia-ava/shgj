import { useState } from 'react';
import { api, type Session } from '../api';
import { ErrorBanner } from '../App';
import { CreateHouseholdForm, JoinHouseholdForm } from './HouseholdForms';

type Mode = 'pick' | 'create' | 'join';

/**
 * 「已登录，但当前房间下没有身份」时显示的中转页。
 *
 * 什么情况会走到这里：
 *   - 刚注册完，还没建房也没加入（households 是空数组）
 *   - 从当前房间退租了（households 里还有别的房间，但 active_household_id 指向的
 *     那个已经没了，或者压根还是 NULL）
 *   - 在另一个标签页退租，本标签页 visibilitychange 同步过来的
 *
 * ⚠️ 三个出口一个都不能少。只给「选已有房间」的话，用户把唯一的房间退掉之后
 *    会看到一张空列表，然后**没有任何办法回到主界面**——连退出登录都没有出路，
 *    因为再注册一个账号也还是这个页面。
 *
 * 「建新房间 / 用邀请码加入」两个表单住在 HouseholdForms.tsx 里，因为顶栏的
 * 「＋ 房间」弹窗要用同一份实现（见那个文件顶部的注释）。
 */
export default function HouseholdGate({
  session,
  onChanged,
  onLogout,
}: {
  session: Session;
  onChanged: () => Promise<void>;
  /**
   * ⚠️ 不能拿 onChanged 当退出用。onChanged 走的是 reloadSession() → api.me()，
   *    登出之后这个请求必然 401，Promise 直接 reject，session 保持旧值——
   *    用户点了退出却还停在门口页，怎么点都出不去。
   *    必须走 App 的 logout()，它会无条件把本地状态清空。
   */
  onLogout: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>(session.households.length > 0 ? 'pick' : 'create');

  // 只有「选已有房间」这一个分支还需要自己管 busy/error；两个表单各自管自己那份，
  // 所以切模式时它们的错误会自动跟着组件卸载一起清掉，不会串台。
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function go(next: Mode) {
    setError(null);
    setMode(next);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        {session.account && (
          <p className="small faint" style={{ marginBottom: 4 }}>
            已登录：{session.account.email}
          </p>
        )}

        {/* ── 选已有房间 ─────────────────────────────────────────── */}
        {mode === 'pick' && (
          <>
            <h1 className="auth-title">选一个房间</h1>
            <p className="auth-desc">你在这些房间里都有身份</p>

            <ErrorBanner error={error} />

            <div className="member-grid" style={{ marginBottom: 16 }}>
              {session.households.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="member-chip"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await api.switchHousehold(h.id);
                      await onChanged();
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {h.name}
                  <span className="chip-sub">
                    {h.memberName}
                    {h.room ? ` · ${h.room}` : ''}
                  </span>
                </button>
              ))}
            </div>

            <div className="alert alert-info">
              你当前没有正在使用的房间。选一个进去，或者新建 / 加入一个。
            </div>
          </>
        )}

        {/* ── 建新房间 ──────────────────────────────────────────── */}
        {mode === 'create' && (
          <>
            <h1 className="auth-title">建一个新房间</h1>
            <p className="auth-desc">
              一个房间一个账本。合租换地方了就再建一个，旧账本留在原房间里。
            </p>

            <CreateHouseholdForm onDone={onChanged} />
          </>
        )}

        {/* ── 用邀请码加入 ──────────────────────────────────────── */}
        {mode === 'join' && (
          <>
            <h1 className="auth-title">加入房间</h1>

            <JoinHouseholdForm onDone={onChanged} />
          </>
        )}

        {/* 三个出口互相跳转。已经只有一个房间且没有其它选择时，
            仍然显示「建新房间 / 加入」，因为用户可能就是想换个地方。 */}
        <p className="auth-switch" style={{ marginTop: 20 }}>
          {mode !== 'pick' && session.households.length > 0 && (
            <>
              <button type="button" className="link" onClick={() => go('pick')}>
                选已有房间
              </button>
              <span className="faint"> · </span>
            </>
          )}
          {mode !== 'create' && (
            <>
              <button type="button" className="link" onClick={() => go('create')}>
                建新房间
              </button>
              <span className="faint"> · </span>
            </>
          )}
          {mode !== 'join' && (
            <button type="button" className="link" onClick={() => go('join')}>
              用邀请码加入
            </button>
          )}
        </p>

        <p className="auth-switch">
          <button type="button" className="link faint" onClick={() => void onLogout()}>
            退出登录
          </button>
        </p>
      </div>
    </div>
  );
}
