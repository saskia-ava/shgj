import { useState } from 'react';
import { api, type Session } from '../api';
import { ErrorBanner } from '../App';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [householdName, setHouseholdName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [room, setRoom] = useState('');

  const [code, setCode] = useState('');
  const [looked, setLooked] = useState<{ name: string; members: { id: string; name: string; claimed: boolean }[] } | null>(null);

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
                  onClick={() =>
                    run(async () => {
                      await api.switchHousehold(h.id);
                      await onChanged();
                    })
                  }
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

            <ErrorBanner error={error} />

            <div className="field">
              <label htmlFor="hh">房间名</label>
              <input
                id="hh"
                value={householdName}
                onChange={(e) => setHouseholdName(e.target.value)}
                placeholder="例如：望京西园三区 502"
                maxLength={30}
              />
            </div>

            <div className="row">
              <div className="field">
                <label htmlFor="hn">你在房间里的名字</label>
                <input
                  id="hn"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  placeholder="例如：小明"
                  maxLength={20}
                />
              </div>
              <div className="field">
                <label htmlFor="hr">房间（选填）</label>
                <input
                  id="hr"
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  placeholder="例如：主卧"
                  maxLength={20}
                />
              </div>
            </div>

            <div className="small faint" style={{ marginBottom: 12 }}>
              建好之后会给你一个邀请码，室友用它加入。
            </div>

            <button
              type="button"
              className="btn btn-block"
              disabled={busy || !householdName.trim() || !memberName.trim()}
              onClick={() =>
                run(async () => {
                  await api.createHousehold({
                    householdName: householdName.trim(),
                    memberName: memberName.trim(),
                    room: room.trim() || undefined,
                  });
                  await onChanged();
                })
              }
            >
              {busy ? '创建中…' : '创建房间'}
            </button>
          </>
        )}

        {/* ── 用邀请码加入 ──────────────────────────────────────── */}
        {mode === 'join' && (
          <>
            <h1 className="auth-title">加入房间</h1>

            <ErrorBanner error={error} />

            {!looked ? (
              <>
                <p className="auth-desc">输入室友给你的邀请码</p>
                <div className="field">
                  <label htmlFor="ghc">邀请码</label>
                  <input
                    id="ghc"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="8 位邀请码"
                    className="mono"
                    maxLength={12}
                    autoCapitalize="characters"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy || code.trim().length < 4}
                  onClick={() =>
                    run(async () => {
                      const res = await api.lookupHousehold(code.trim());
                      setLooked({ name: res.household.name, members: res.members });
                    })
                  }
                >
                  {busy ? '查询中…' : '下一步'}
                </button>
              </>
            ) : (
              <>
                <div className="alert alert-info">加入「{looked.name}」</div>

                {looked.members.filter((m) => !m.claimed).length > 0 && (
                  <div className="small faint" style={{ marginBottom: 12 }}>
                    室友已经替你建好了名字？
                    {looked.members
                      .filter((m) => !m.claimed)
                      .map((m) => m.name)
                      .join('、')}
                    ——把名字填成完全一样，就会接上已有的档案，历史账目不会断。
                  </div>
                )}

                <div className="row">
                  <div className="field">
                    <label htmlFor="gn">你的名字</label>
                    <input
                      id="gn"
                      value={memberName}
                      onChange={(e) => setMemberName(e.target.value)}
                      maxLength={20}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="gr">房间（选填）</label>
                    <input
                      id="gr"
                      value={room}
                      onChange={(e) => setRoom(e.target.value)}
                      maxLength={20}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-block"
                  disabled={busy || !memberName.trim()}
                  onClick={() =>
                    run(async () => {
                      await api.join({
                        inviteCode: code.trim(),
                        name: memberName.trim(),
                        room: room.trim() || undefined,
                      });
                      await onChanged();
                    })
                  }
                >
                  {busy ? '加入中…' : '加入房间'}
                </button>
              </>
            )}
          </>
        )}

        {/* 三个出口互相跳转。已经只有一个房间且没有其它选择时，
            仍然显示「建新房间 / 加入」，因为用户可能就是想换个地方。 */}
        <p className="auth-switch" style={{ marginTop: 20 }}>
          {mode !== 'pick' && session.households.length > 0 && (
            <>
              <button type="button" className="link" onClick={() => { setError(null); setMode('pick'); }}>
                选已有房间
              </button>
              <span className="faint"> · </span>
            </>
          )}
          {mode !== 'create' && (
            <>
              <button type="button" className="link" onClick={() => { setError(null); setMode('create'); }}>
                建新房间
              </button>
              <span className="faint"> · </span>
            </>
          )}
          {mode !== 'join' && (
            <button type="button" className="link" onClick={() => { setError(null); setMode('join'); }}>
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
