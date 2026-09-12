import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type BalanceEntry, type Settlement, type Transfer } from '../api';
import { ErrorBanner, useApp } from '../App';
import { fmtMoney, fmtRelativeDate, fmtSigned, parseMoneyInput } from '../format';

export default function Balance() {
  const { session, members, activeMembers } = useApp();

  const [balances, setBalances] = useState<BalanceEntry[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [history, setHistory] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // 手动记一笔转账
  const [showManual, setShowManual] = useState(false);
  const [mFrom, setMFrom] = useState('');
  const [mTo, setMTo] = useState('');
  const [mAmount, setMAmount] = useState('');
  const [mNote, setMNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([api.balances(), api.listSettlements({ limit: 30 })]);
      setBalances(b.balances);
      setTransfers(b.transfers);
      setHistory(s.settlements);
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

  // 返回的是「处理器」而不是调用结果：直接写 onClick={settleTransfer(t)} 会在渲染时
  // 立刻记账，而不是等点击。
  const settleTransfer = (t: Transfer) =>
    act(() =>
      api.createSettlement({
        from: t.from,
        to: t.to,
        amount: t.amount,
        note: '按结算建议记录',
      }),
    );

  // 直接就是点击处理器本身（不要再包一层箭头函数，否则点击只会「返回」而不执行）
  const submitManual = act(async () => {
    const amount = parseMoneyInput(mAmount);
    if (!amount) throw new ApiError(0, '请填写正确的金额');
    if (!mFrom || !mTo) throw new ApiError(0, '请选择付款人和收款人');
    await api.createSettlement({ from: mFrom, to: mTo, amount, note: mNote.trim() || undefined });
    setMAmount('');
    setMNote('');
    setShowManual(false);
  });

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" />
        正在计算…
      </div>
    );
  }

  const allSettled = balances.every((b) => b.amount === 0);

  return (
    <>
      <ErrorBanner error={error} />

      <div className="section-title">各自的净额</div>
      <div className="card">
        {balances.length === 0 ? (
          <div className="empty">
            <div className="empty-title">还没有室友</div>
            <div className="empty-desc">先去「室友」页添加成员</div>
          </div>
        ) : (
          balances.map((b) => (
            <div key={b.memberId} className="list-item">
              <div className="list-main">
                <div className="list-title">
                  {b.name}
                  {b.memberId === session.member.id && <span className="tag tag-primary" style={{ marginLeft: 6 }}>我</span>}
                  {!b.isActive && <span className="tag" style={{ marginLeft: 6 }}>已退租</span>}
                </div>
                <div className="list-meta">
                  {b.amount > 0 ? '应收' : b.amount < 0 ? '应付' : '已结清'}
                </div>
              </div>
              <div
                className={`list-amount ${
                  b.amount > 0 ? 'amount-pos' : b.amount < 0 ? 'amount-neg' : 'amount-zero'
                }`}
              >
                {fmtSigned(b.amount)}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="section-title">
        {allSettled ? '结算状态' : `结清需要 ${transfers.length} 笔转账`}
      </div>

      {allSettled ? (
        <div className="card">
          <div className="empty" style={{ padding: '24px 12px' }}>
            <div className="empty-icon">✅</div>
            <div className="empty-title">账已经平了</div>
            <div className="empty-desc">所有人互不相欠</div>
          </div>
        </div>
      ) : (
        <>
          {transfers.map((t, i) => (
            <div key={`${t.from}-${t.to}-${i}`} className="transfer">
              <div className="transfer-people">
                <strong>{t.fromName}</strong>
                <span className="transfer-arrow"> → </span>
                <strong>{t.toName}</strong>
              </div>
              <div className="list-amount">{fmtMoney(t.amount)}</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={settleTransfer(t)}
              >
                已转
              </button>
            </div>
          ))}
          <p className="small faint" style={{ marginTop: 8 }}>
            这是笔数最少的还法。实际怎么转可以随意，只要大家最终的净额对上就行。
          </p>
        </>
      )}

      <div className="section-title">手动记一笔转账</div>
      <div className="card">
        {!showManual ? (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setShowManual(true)}>
            记录一笔实际转账
          </button>
        ) : (
          <>
            <div className="row">
              <div className="field">
                <label htmlFor="mf">谁转的</label>
                <select id="mf" value={mFrom} onChange={(e) => setMFrom(e.target.value)}>
                  <option value="">请选择</option>
                  {activeMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="mt">转给谁</label>
                <select id="mt" value={mTo} onChange={(e) => setMTo(e.target.value)}>
                  <option value="">请选择</option>
                  {activeMembers
                    .filter((m) => m.id !== mFrom)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="ma">金额（元）</label>
                <input
                  id="ma"
                  inputMode="decimal"
                  value={mAmount}
                  onChange={(e) => setMAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label htmlFor="mnote">备注（选填）</label>
                <input id="mnote" value={mNote} onChange={(e) => setMNote(e.target.value)} />
              </div>
            </div>
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy} onClick={submitManual}>
                保存
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowManual(false)}>
                取消
              </button>
            </div>
          </>
        )}
      </div>

      <div className="section-title">结算历史</div>
      <div className="card">
        {history.length === 0 ? (
          <div className="small faint text-center" style={{ padding: '16px 0' }}>
            还没有结算记录
          </div>
        ) : (
          history.map((s) => (
            <div key={s.id} className="list-item">
              <div className="list-main">
                <div className="list-title">
                  {s.fromName} <span className="faint">→</span> {s.toName}
                </div>
                <div className="list-meta">
                  {fmtRelativeDate(s.settledOn)}
                  {s.note ? ` · ${s.note}` : ''}
                </div>
              </div>
              <div className="list-amount">{fmtMoney(s.amount)}</div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={act(() => api.deleteSettlement(s.id))}
                title="撤销这笔记录"
              >
                撤销
              </button>
            </div>
          ))
        )}
      </div>

      {/* 退租成员也可能有未结清的余额，这里明确提示，避免被忽略 */}
      {members.some((m) => !m.isActive) && (
        <p className="small faint" style={{ marginTop: 12 }}>
          已退租的室友也计入余额计算——他们之前垫付或分摊的钱仍需结清。
        </p>
      )}
    </>
  );
}
