import { useCallback, useEffect, useState } from 'react';
import { api, type Announcement } from '../api';
import { ErrorBanner, useApp } from '../App';
import { fmtRelativeDate } from '../format';

export default function Announcements() {
  const { session } = useApp();
  const [list, setList] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  const load = useCallback(async () => {
    try {
      const { announcements } = await api.listAnnouncements();
      setList(announcements);
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

  const publish = () =>
    act(async () => {
      await api.createAnnouncement({ title: title.trim(), content: content.trim(), isPinned: pinned });
      setTitle('');
      setContent('');
      setPinned(false);
      setShowAdd(false);
    })();

  // 返回的是「处理器」而不是调用结果：直接写 onClick={saveEdit(a.id)} 会在渲染时
  // 立刻执行保存，而不是等点击。
  const saveEdit = (id: string) =>
    act(async () => {
      await api.updateAnnouncement(id, { title: editTitle.trim(), content: editContent.trim() });
      setEditingId(null);
    });

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在加载…
      </div>
    );
  }

  return (
    <>
      <ErrorBanner error={error} />

      {!showAdd ? (
        <button type="button" className="btn btn-block" onClick={() => setShowAdd(true)}>
          + 发布公告
        </button>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">发布公告</h2>
          </div>
          <div className="field">
            <label htmlFor="at">标题</label>
            <input
              id="at"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：周六上午保洁来打扫"
              maxLength={40}
            />
          </div>
          <div className="field">
            <label htmlFor="ac">内容</label>
            <textarea
              id="ac"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder="写清楚时间、要做什么、需要谁配合"
              maxLength={2000}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <span>置顶这条公告</span>
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={busy || !title.trim() || !content.trim()}
              onClick={publish}
            >
              发布
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="empty">
            <div className="empty-icon">📌</div>
            <div className="empty-title">还没有公告</div>
            <div className="empty-desc">有什么要通知大家的，发在这里</div>
          </div>
        </div>
      ) : (
        list.map((a) => (
          <div className={`card${a.isPinned ? ' card-pinned' : ''}`} key={a.id}>
            {editingId === a.id ? (
              <>
                <div className="field">
                  <label htmlFor={`et-${a.id}`}>标题</label>
                  <input
                    id={`et-${a.id}`}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    maxLength={40}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`ec-${a.id}`}>内容</label>
                  <textarea
                    id={`ec-${a.id}`}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={5}
                    maxLength={2000}
                  />
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || !editTitle.trim() || !editContent.trim()}
                    onClick={saveEdit(a.id)}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setEditingId(null)}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="card-head">
                  <div style={{ minWidth: 0 }}>
                    <h2 className="card-title">
                      {a.isPinned && <span className="pin-mark">📌</span>}
                      {a.title}
                    </h2>
                    <p className="card-sub">
                      {a.authorName} · {fmtRelativeDate(a.createdAt)}
                    </p>
                  </div>
                </div>

                <p className="ann-body">{a.content}</p>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={act(() => api.updateAnnouncement(a.id, { isPinned: !a.isPinned }))}
                  >
                    {a.isPinned ? '取消置顶' : '置顶'}
                  </button>
                  {/* 只有作者能改自己的公告——别人发的东西被我改掉会说不清 */}
                  {a.authorId === session.member.id && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditingId(a.id);
                        setEditTitle(a.title);
                        setEditContent(a.content);
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {a.authorId === session.member.id && (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={act(() => api.deleteAnnouncement(a.id))}
                    >
                      删除
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))
      )}
    </>
  );
}
