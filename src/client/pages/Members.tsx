import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner, useApp } from '../App';
import { fmtDate } from '../format';

export default function Members() {
  const { session, members, reloadMembers } = useApp();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [phone, setPhone] = useState('');

  // 修改自己的 PIN
  const [showPin, setShowPin] = useState(false);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');

  const me = members.find((m) => m.id === session.member.id);

  // 返回 void 而不是 Promise：这些函数直接挂到 onClick 上，
  // 返回 Promise 既不是合法的点击处理器，也会吞掉异常。
  const act = (fn: () => Promise<unknown>) => () => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await reloadMembers();
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    })();
  };

  const addMember = () =>
    act(async () => {
      await api.addMember({
        name: name.trim(),
        room: room.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setName('');
      setRoom('');
      setPhone('');
      setShowAdd(false);
    })();

  const changePin = () =>
    act(async () => {
      await api.changePin(session.member.id, {
        oldPin: me?.hasPin ? oldPin : undefined,
        newPin,
      });
      setOldPin('');
      setNewPin('');
      setShowPin(false);
    })();

  const active = members.filter((m) => m.isActive);
  const inactive = members.filter((m) => !m.isActive);

  return (
    <>
      <ErrorBanner error={error} />

      <div className="card">
        <div className="invite-box">
          <div className="invite-hint">把邀请码发给室友，他们就能加入</div>
          <div className="invite-code">{session.household.inviteCode}</div>
          <div className="invite-hint">点一下可以选中复制</div>
        </div>
      </div>

      <div className="section-title">在住（{active.length} 人）</div>
      <div className="card">
        {active.map((m) => (
          <div key={m.id} className="list-item">
            <div className="list-main">
              <div className="list-title">
                {m.name}
                {m.id === session.member.id && (
                  <span className="tag tag-primary" style={{ marginLeft: 6 }}>
                    我
                  </span>
                )}
              </div>
              <div className="list-meta">
                {[m.room, m.phone].filter(Boolean).join(' · ') || '未填写房间和联系方式'}
                {!m.hasPin && ' · 还没设置 PIN'}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={act(() => api.leaveMember(m.id))}
              title="标记为已退租"
            >
              退租
            </button>
          </div>
        ))}
      </div>

      {!showAdd ? (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setShowAdd(true)}>
          + 添加室友（占位）
        </button>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">添加室友</h2>
          </div>
          <p className="small faint" style={{ marginTop: 0 }}>
            先建好名字，对方用邀请码加入时点自己的名字就能认领，不用重复添加。
          </p>
          <div className="row">
            <div className="field">
              <label htmlFor="an">名字</label>
              <input id="an" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} />
            </div>
            <div className="field">
              <label htmlFor="ar">房间（选填）</label>
              <input id="ar" value={room} onChange={(e) => setRoom(e.target.value)} maxLength={20} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ap">联系方式（选填）</label>
            <input id="ap" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy || !name.trim()} onClick={addMember}>
              添加
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="section-title">修改我的 PIN</div>
      <div className="card">
        {!showPin ? (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setShowPin(true)}>
            修改 PIN
          </button>
        ) : (
          <>
            {me?.hasPin && (
              <div className="field">
                <label htmlFor="op">当前 PIN</label>
                <input
                  id="op"
                  type="password"
                  value={oldPin}
                  onChange={(e) => setOldPin(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="np">新 PIN</label>
              <input
                id="np"
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="至少 4 位"
                autoComplete="new-password"
              />
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                disabled={busy || newPin.length < 4 || (me?.hasPin && !oldPin)}
                onClick={changePin}
              >
                保存
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowPin(false)}>
                取消
              </button>
            </div>
          </>
        )}
        <p className="small faint" style={{ marginTop: 10 }}>
          出于安全考虑，只有本人能改自己的 PIN——如果允许改别人的，拿到邀请码的人就能直接冒充他人登录，
          登录的失败锁定也就白做了。代价是忘记 PIN 后无法自助找回。
        </p>
      </div>

      {inactive.length > 0 && (
        <>
          <div className="section-title">已退租（{inactive.length} 人）</div>
          <div className="card">
            <p className="small faint" style={{ marginTop: 0 }}>
              他们的历史账目仍然参与计算，所以这几条记录不能删。
            </p>
            {inactive.map((m) => (
              <div key={m.id} className="list-item">
                <div className="list-main">
                  <div className="list-title strike">{m.name}</div>
                  <div className="list-meta">
                    {m.room ? `${m.room} · ` : ''}
                    {m.moveOut ? `${fmtDate(m.moveOut)} 退租` : '已退租'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={act(() => api.restoreMember(m.id))}
                >
                  恢复在住
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
