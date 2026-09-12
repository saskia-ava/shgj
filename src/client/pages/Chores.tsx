import { useCallback, useEffect, useState } from 'react';
import { api, type Chore } from '../api';
import { ErrorBanner, useApp } from '../App';
import { CYCLE_LABEL, fmtRelativeDate } from '../format';

export default function Chores() {
  const { activeMembers, session, nameOf } = useApp();
  const [chores, setChores] = useState<Chore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [cycle, setCycle] = useState('weekly');
  const [picked, setPicked] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const { chores: list } = await api.listChores();
      setChores(list);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 返回 void 而不是 Promise：这些函数直接挂到 onClick 上，
  // 返回 Promise 既不是合法的点击处理器，也会吞掉异常。
  const act = (fn: () => Promise<unknown>) => () => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    })();
  };

  const togglePick = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const create = () =>
    act(async () => {
      await api.createChore({ name: name.trim(), cycle, memberIds: picked });
      setName('');
      setPicked([]);
      setShowAdd(false);
    })();

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在加载…
      </div>
    );
  }

  const active = chores.filter((c) => c.isActive);
  const paused = chores.filter((c) => !c.isActive);

  return (
    <>
      <ErrorBanner error={error} />

      <div className="section-title">进行中（{active.length} 项）</div>

      {active.length === 0 && !showAdd ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon">🧹</div>
            <div className="empty-title">还没有值日安排</div>
            <div className="empty-desc">加一项，大家轮流做</div>
          </div>
        </div>
      ) : (
        active.map((c) => {
          const isMine = c.currentAssignee?.id === session.member.id;
          const done = Boolean(c.doneAt);
          return (
            <div className="card" key={c.id}>
              <div className="card-head">
                <div>
                  <h2 className="card-title">{c.name}</h2>
                  <p className="card-sub">{CYCLE_LABEL[c.cycle] ?? c.cycle}轮换</p>
                </div>
                {done ? (
                  <span className="tag tag-success">本期已完成</span>
                ) : isMine ? (
                  <span className="tag tag-warn">轮到我</span>
                ) : (
                  <span className="tag">待完成</span>
                )}
              </div>

              <div className="list-item" style={{ paddingTop: 0 }}>
                <div className="list-main">
                  <div className="list-meta">本期轮到</div>
                  <div className="list-title">{c.currentAssignee?.name ?? '—'}</div>
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || done}
                    onClick={act(() => api.completeChore(c.id))}
                  >
                    {done ? '已完成' : '标记完成'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={act(() => api.updateChore(c.id, { isActive: false }))}
                  >
                    暂停
                  </button>
                </div>
              </div>

              <div className="list-meta" style={{ marginTop: 10 }}>
                轮转顺序：{c.memberIds.map((id) => nameOf(id)).join(' → ')}
              </div>
            </div>
          );
        })
      )}

      {!showAdd ? (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setShowAdd(true)}>
          + 新增值日项目
        </button>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">新增值日项目</h2>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="cn">项目名称</label>
              <input
                id="cn"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：扫地拖地"
                maxLength={30}
              />
            </div>
            <div className="field">
              <label htmlFor="cc">轮换周期</label>
              <select id="cc" value={cycle} onChange={(e) => setCycle(e.target.value)}>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label>轮转成员（按点击顺序轮换）</label>
            <div className="member-grid">
              {activeMembers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`member-chip${picked.includes(m.id) ? ' on' : ''}`}
                  onClick={() => togglePick(m.id)}
                >
                  {picked.includes(m.id) ? `${picked.indexOf(m.id) + 1}. ` : ''}
                  {m.name}
                </button>
              ))}
            </div>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={busy || !name.trim() || picked.length === 0}
              onClick={create}
            >
              创建
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {paused.length > 0 && (
        <>
          <div className="section-title">已暂停</div>
          <div className="card">
            {paused.map((c) => (
              <div key={c.id} className="list-item">
                <div className="list-main">
                  <div className="list-title strike">{c.name}</div>
                  <div className="list-meta">{CYCLE_LABEL[c.cycle] ?? c.cycle}</div>
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={act(() => api.updateChore(c.id, { isActive: true }))}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={act(() => api.deleteChore(c.id))}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="small faint" style={{ marginTop: 12 }}>
        每期只有一次「完成」机会，完成后自动轮到下一个人。
        {chores.some((c) => c.doneAt) &&
          ` 最近完成：${fmtRelativeDate(Math.max(...chores.filter((c) => c.doneAt).map((c) => c.doneAt!)))}`}
      </p>
    </>
  );
}
