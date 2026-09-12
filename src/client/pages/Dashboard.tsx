import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type Announcement,
  type BalanceEntry,
  type Chore,
  type Expense,
  type Item,
  type Transfer,
} from '../api';
import { ErrorBanner, useApp } from '../App';
import { fmtDate, fmtMoney, fmtRelativeDate, fmtSigned } from '../format';

export default function Dashboard({ onNavigate }: { onNavigate: (key: string) => void }) {
  const { session } = useApp();

  const [balances, setBalances] = useState<BalanceEntry[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [chores, setChores] = useState<Chore[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [recent, setRecent] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    // 首页汇总了五个模块，任一个失败都不该让整页白掉，
    // 因此用 allSettled：拿到几个算几个。
    const [b, ch, an, it, ex] = await Promise.allSettled([
      api.balances(),
      api.listChores(),
      api.listAnnouncements(),
      api.listItems(),
      api.listExpenses({ limit: 5 }),
    ]);

    const failed = [b, ch, an, it, ex].find((r) => r.status === 'rejected');
    setError(failed && failed.status === 'rejected' ? failed.reason : null);

    if (b.status === 'fulfilled') {
      setBalances(b.value.balances);
      setTransfers(b.value.transfers);
    }
    if (ch.status === 'fulfilled') setChores(ch.value.chores);
    if (an.status === 'fulfilled') setAnnouncements(an.value.announcements);
    if (it.status === 'fulfilled') setItems(it.value.items);
    if (ex.status === 'fulfilled') setRecent(ex.value.expenses);

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在加载…
      </div>
    );
  }

  const mine = balances.find((b) => b.memberId === session.member.id);
  const myChores = chores.filter(
    (c) => c.isActive && !c.doneAt && c.currentAssignee?.id === session.member.id,
  );
  const openChores = chores.filter((c) => c.isActive && !c.doneAt);
  const restock = items.filter((i) => i.needsRestock);
  const pinned = announcements.filter((a) => a.isPinned);
  const latest = [...pinned, ...announcements.filter((a) => !a.isPinned)].slice(0, 3);
  const myTransfers = transfers.filter(
    (t) => t.from === session.member.id || t.to === session.member.id,
  );

  const myAmount = mine?.amount ?? 0;
  const settleHint =
    myAmount > 0
      ? { text: `大家一共欠你 ${fmtMoney(myAmount)}`, tone: 'pos' as const }
      : myAmount < 0
        ? { text: `你一共欠大家 ${fmtMoney(-myAmount)}`, tone: 'neg' as const }
        : { text: '你和大家两清了', tone: 'zero' as const };

  return (
    <>
      <ErrorBanner error={error} />

      {/* 我自己的余额放最上面——这是打开应用最想知道的一件事 */}
      <div className={`hero hero-${settleHint.tone}`}>
        <div className="hero-label">我的账</div>
        <div className="hero-amount">{fmtSigned(myAmount)}</div>
        <div className="hero-hint">{settleHint.text}</div>

        {myTransfers.length > 0 && (
          <div className="hero-actions">
            {myTransfers.map((t, i) => (
              <button
                key={`${t.from}-${t.to}-${i}`}
                type="button"
                className="hero-action"
                onClick={() => onNavigate('balance')}
              >
                {t.from === session.member.id
                  ? `转给 ${t.toName} ${fmtMoney(t.amount)}`
                  : `收 ${t.fromName} ${fmtMoney(t.amount)}`}
              </button>
            ))}
          </div>
        )}

        {myTransfers.length === 0 && myAmount !== 0 && (
          <div className="hero-actions">
            <button type="button" className="hero-action" onClick={() => onNavigate('balance')}>
              看怎么结清
            </button>
          </div>
        )}
      </div>

      <div className="quick-grid">
        <button type="button" className="quick" onClick={() => onNavigate('expenses')}>
          <span className="quick-icon">🧾</span>
          <span>记一笔</span>
        </button>
        <button type="button" className="quick" onClick={() => onNavigate('balance')}>
          <span className="quick-icon">💰</span>
          <span>结算</span>
        </button>
        <button type="button" className="quick" onClick={() => onNavigate('chores')}>
          <span className="quick-icon">🧹</span>
          <span>值日</span>
        </button>
        <button type="button" className="quick" onClick={() => onNavigate('announcements')}>
          <span className="quick-icon">📌</span>
          <span>公告</span>
        </button>
      </div>

      {myChores.length > 0 && (
        <>
          <div className="section-title">轮到我做</div>
          <div className="card card-warn">
            {myChores.map((c) => (
              <div key={c.id} className="list-item">
                <div className="list-main">
                  <div className="list-title">{c.name}</div>
                  <div className="list-meta">
                    {c.periodStart ? `${fmtDate(c.periodStart)} 这一期` : '本期'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onNavigate('chores')}
                >
                  去处理
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {myChores.length === 0 && openChores.length > 0 && (
        <>
          <div className="section-title">值日</div>
          <div className="card">
            <div className="list-item">
              <div className="list-main">
                <div className="list-title">这期不轮到你</div>
                <div className="list-meta">
                  {openChores
                    .map((c) => `${c.name}：${c.currentAssignee?.name ?? '—'}`)
                    .slice(0, 3)
                    .join(' · ')}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {restock.length > 0 && (
        <>
          <div className="section-title">该补货</div>
          <div className="card card-warn">
            {restock.slice(0, 5).map((i) => (
              <div key={i.id} className="list-item">
                <div className="list-main">
                  <div className="list-title">{i.name}</div>
                  <div className="list-meta">
                    只剩 {i.quantity}
                    {i.unit ?? ''}（低于 {i.minQuantity} 就该买）
                  </div>
                </div>
              </div>
            ))}
            {restock.length > 5 && (
              <div className="small faint" style={{ paddingTop: 8 }}>
                还有 {restock.length - 5} 样…
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('items')}>
              去更新数量
            </button>
          </div>
        </>
      )}

      {latest.length > 0 && (
        <>
          <div className="section-title">公告</div>
          {latest.map((a) => (
            <div className={`card${a.isPinned ? ' card-pinned' : ''}`} key={a.id}>
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
              <p className="ann-body clamp-3">{a.content}</p>
            </div>
          ))}
          {announcements.length > latest.length && (
            <button
              type="button"
              className="btn btn-ghost btn-block btn-sm"
              onClick={() => onNavigate('announcements')}
            >
              看全部 {announcements.length} 条公告
            </button>
          )}
        </>
      )}

      <div className="section-title">
        最近的账
        <button type="button" className="link small" onClick={() => onNavigate('expenses')}>
          全部
        </button>
      </div>
      <div className="card">
        {recent.length === 0 ? (
          <div className="empty" style={{ padding: '20px 12px' }}>
            <div className="empty-title">还没有账目</div>
            <div className="empty-desc">点上面的「记一笔」开始</div>
          </div>
        ) : (
          recent.map((e) => (
            <div key={e.id} className="list-item">
              <div className="list-main">
                <div className="list-title">{e.title}</div>
                <div className="list-meta">
                  {e.paidByName} 垫付 · {fmtDate(e.spentOn)} · {e.category}
                </div>
              </div>
              <div className="list-amount">{fmtMoney(e.amount)}</div>
            </div>
          ))
        )}
      </div>

      <p className="small faint" style={{ marginTop: 16, textAlign: 'center' }}>
        {session.household.name} · 邀请码 {session.household.inviteCode}
        <br />
        当前在住 {balances.filter((b) => b.isActive).length} 人
        {balances.some((b) => !b.isActive) &&
          `（另有 ${balances.filter((b) => !b.isActive).length} 位已退租，其账目仍计入）`}
      </p>
    </>
  );
}
