import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner, useApp } from '../App';
import { fmtDate } from '../format';
import Avatar from '../components/Avatar';

/**
 * 房间里的成员。
 *
 * ⚠️ 邀请码、修改密码、设置 PIN 都不在这个页面了——它们挪到了顶栏的
 *    头像菜单里（点右上角头像 → 对应项）。**不是删掉，是搬家**：
 *    这几件事原来散在「顶栏 + 室友页底部」两处，找起来要在两个地方翻，
 *    现在统一在头像菜单一个入口。
 *    这里留下的都是「这个房间里的人」相关的事：名单、加占位、退租、恢复。
 */
export default function Members() {
  const { session, members, reloadMembers } = useApp();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [phone, setPhone] = useState('');

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

  const active = members.filter((m) => m.isActive);
  const inactive = members.filter((m) => !m.isActive);

  return (
    <>
      <ErrorBanner error={error} />

      <div className="section-title">在住（{active.length} 人）</div>
      <div className="card">
        {active.map((m) => (
          <div key={m.id} className="list-item">
            <Avatar value={m.avatar} name={m.name} size={36} />
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

      <p className="small faint" style={{ textAlign: 'center', marginTop: 16 }}>
        邀请码、修改密码、设置 PIN 都在右上角的<strong>头像菜单</strong>里。
      </p>

      {inactive.length > 0 && (
        <>
          <div className="section-title">已退租（{inactive.length} 人）</div>
          <div className="card">
            <p className="small faint" style={{ marginTop: 0 }}>
              他们的历史账目仍然参与计算，所以这几条记录不能删。
            </p>
            {inactive.map((m) => (
              <div key={m.id} className="list-item">
                <Avatar value={m.avatar} name={m.name} size={36} className="dim" />
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
