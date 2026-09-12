import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Expense } from '../api';
import { ErrorBanner, useApp } from '../App';
import {
  CATEGORIES,
  fmtDate,
  fmtMoney,
  fromDateInput,
  parseMoneyInput,
  toDateInput,
} from '../format';

const PAGE_SIZE = 30;

export default function Expenses() {
  const { session, nameOf } = useApp();

  const [list, setList] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listExpenses({
        limit: PAGE_SIZE,
        offset,
        category: category || undefined,
      });
      setList(res.expenses);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [offset, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = (fn: () => Promise<unknown>) => async () => {
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
  };

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (e: Expense) => {
    setEditing(e);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  // 只算本页的合计。全局合计要再发一次聚合查询，对合租场景价值不大。
  const pageTotal = useMemo(() => list.reduce((s, e) => s + e.amount, 0), [list]);
  const maxOffset = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE;

  return (
    <>
      <ErrorBanner error={error} />

      {!formOpen ? (
        <button type="button" className="btn btn-block" onClick={openNew}>
          + 记一笔
        </button>
      ) : (
        <ExpenseForm
          key={editing?.id ?? 'new'}
          editing={editing}
          busy={busy}
          onCancel={closeForm}
          onSubmit={async (payload) => {
            setBusy(true);
            setError(null);
            try {
              if (editing) {
                await api.updateExpense(editing.id, payload);
              } else {
                await api.createExpense(payload as Parameters<typeof api.createExpense>[0]);
              }
              closeForm();
              await load();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      <div className="section-title">
        账目明细
        <select
          className="inline-select"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部分类</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner" />
          正在加载…
        </div>
      ) : list.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon">🧾</div>
            <div className="empty-title">{category ? '这个分类下还没有账目' : '还没有记过账'}</div>
            <div className="empty-desc">谁先垫的钱记一笔，月底就不用翻聊天记录了</div>
          </div>
        </div>
      ) : (
        <>
          {list.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <div className="card" key={e.id}>
                <div className="card-head">
                  <div style={{ minWidth: 0 }}>
                    <h2 className="card-title">
                      {e.title}
                      <span className="tag" style={{ marginLeft: 6 }}>
                        {e.category}
                      </span>
                    </h2>
                    <p className="card-sub">
                      {e.paidByName} 垫付 · {fmtDate(e.spentOn)}
                      {e.note ? ` · ${e.note}` : ''}
                    </p>
                  </div>
                  <div className="list-amount">{fmtMoney(e.amount)}</div>
                </div>

                <button
                  type="button"
                  className="link small"
                  onClick={() => setExpanded(isOpen ? null : e.id)}
                >
                  {isOpen ? '收起分摊' : `看谁分摊了这 ${fmtMoney(e.amount)}`}
                </button>

                {isOpen && (
                  <div className="share-list">
                    {e.shares.map((s) => (
                      <div key={s.memberId} className="share-row">
                        <span>
                          {nameOf(s.memberId)}
                          {s.memberId === session.member.id && <span className="faint">（我）</span>}
                        </span>
                        <span className="mono">{fmtMoney(s.shareAmount)}</span>
                      </div>
                    ))}
                    <div className="share-row share-total">
                      <span>合计</span>
                      <span className="mono">
                        {fmtMoney(e.shares.reduce((sum, s) => sum + s.shareAmount, 0))}
                      </span>
                    </div>
                  </div>
                )}

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => openEdit(e)}
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={act(() => api.deleteExpense(e.id))}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}

          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </button>
            <span className="small faint">
              本页 {fmtMoney(pageTotal)} · 共 {total} 条
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={offset >= maxOffset}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ── 记账表单 ──────────────────────────────────────────────────────

interface FormProps {
  editing: Expense | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}

function ExpenseForm({ editing, busy, onCancel, onSubmit }: FormProps) {
  const { session, activeMembers } = useApp();

  const [title, setTitle] = useState(editing?.title ?? '');
  const [amountText, setAmountText] = useState(
    editing ? (editing.amount / 100).toFixed(2) : '',
  );
  const [category, setCategory] = useState(editing?.category ?? '日用');
  const [paidBy, setPaidBy] = useState(editing?.paidBy ?? session.member.id);
  const [spentOn, setSpentOn] = useState(toDateInput(editing?.spentOn ?? Date.now()));
  const [note, setNote] = useState(editing?.note ?? '');
  const [splitType, setSplitType] = useState(editing?.splitType ?? 'equal');

  // 均摊：勾选参与人
  const [picked, setPicked] = useState<string[]>(
    editing && editing.splitType === 'equal'
      ? editing.shares.map((s) => s.memberId)
      : activeMembers.map((m) => m.id),
  );

  // 自定义：每人一行金额（元）
  const [custom, setCustom] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (editing && editing.splitType === 'custom') {
      for (const s of editing.shares) init[s.memberId] = (s.shareAmount / 100).toFixed(2);
    }
    return init;
  });

  const [localError, setLocalError] = useState<string | null>(null);

  const amountCents = parseMoneyInput(amountText);

  const togglePick = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // 均摊预览：把服务端的余数规则（多出的几分给靠前的人）在前端复现一遍，
  // 只是为了让人提交前看到自己那份是多少；真正入库的金额仍由服务端算。
  const equalPreview = useMemo(() => {
    if (!amountCents || picked.length === 0) return null;
    const base = Math.floor(amountCents / picked.length);
    let rest = amountCents - base * picked.length;
    return picked.map((id) => {
      const extra = rest > 0 ? 1 : 0;
      if (rest > 0) rest -= 1;
      return { id, cents: base + extra };
    });
  }, [amountCents, picked]);

  const customTotal = useMemo(() => {
    let sum = 0;
    for (const v of Object.values(custom)) {
      const c = parseMoneyInput(v);
      if (c) sum += c;
    }
    return sum;
  }, [custom]);

  const submit = async () => {
    setLocalError(null);
    if (!title.trim()) return setLocalError('请填写账目名称');
    if (!amountCents) return setLocalError('请填写正确的金额');

    const payload: Record<string, unknown> = {
      title: title.trim(),
      amount: amountCents,
      category,
      paidBy,
      spentOn: fromDateInput(spentOn),
      splitType,
      note: note.trim() || undefined,
    };

    if (splitType === 'equal') {
      if (picked.length === 0) return setLocalError('请选择参与分摊的成员');
      payload.memberIds = picked;
    } else {
      const shares = Object.entries(custom)
        .map(([memberId, v]) => ({ memberId, shareAmount: parseMoneyInput(v) ?? 0 }))
        .filter((s) => s.shareAmount > 0);
      if (shares.length === 0) return setLocalError('请填写每个人的分摊金额');
      const sum = shares.reduce((s, x) => s + x.shareAmount, 0);
      if (sum !== amountCents) {
        return setLocalError(
          `分摊之和 ${fmtMoney(sum)} 与总额 ${fmtMoney(amountCents)} 不一致，相差 ${fmtMoney(
            Math.abs(sum - amountCents),
          )}`,
        );
      }
      payload.shares = shares;
    }

    await onSubmit(payload);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="card-title">{editing ? '修改账目' : '记一笔'}</h2>
      </div>

      {localError && <div className="alert alert-error">{localError}</div>}

      <div className="row">
        <div className="field">
          <label htmlFor="etitle">花在什么上</label>
          <input
            id="etitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：九月电费"
            maxLength={50}
          />
        </div>
        <div className="field">
          <label htmlFor="eamount">金额（元）</label>
          <input
            id="eamount"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="ecat">分类</label>
          <select id="ecat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="edate">日期</label>
          <input
            id="edate"
            type="date"
            value={spentOn}
            onChange={(e) => setSpentOn(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="epaid">谁先垫的钱</label>
        <select id="epaid" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
          {activeMembers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>怎么分</label>
        <div className="segmented">
          <button
            type="button"
            className={`seg${splitType === 'equal' ? ' on' : ''}`}
            onClick={() => setSplitType('equal')}
          >
            大家平分
          </button>
          <button
            type="button"
            className={`seg${splitType === 'custom' ? ' on' : ''}`}
            onClick={() => setSplitType('custom')}
          >
            按不同金额分
          </button>
        </div>
      </div>

      {splitType === 'equal' ? (
        <div className="field">
          <label>谁参与分摊</label>
          <div className="member-grid">
            {activeMembers.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`member-chip${picked.includes(m.id) ? ' on' : ''}`}
                onClick={() => togglePick(m.id)}
              >
                {m.name}
                {equalPreview && picked.includes(m.id) && (
                  <span className="chip-sub">
                    {fmtMoney(equalPreview.find((p) => p.id === m.id)?.cents ?? 0)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {amountCents !== null && picked.length > 0 && amountCents % picked.length !== 0 && (
            <div className="small faint" style={{ marginTop: 6 }}>
              {fmtMoney(amountCents)} 除不尽 {picked.length} 人，多出的{' '}
              {fmtMoney(amountCents % picked.length)} 会摊到前几位头上，保证总额一分不差。
            </div>
          )}
        </div>
      ) : (
        <div className="field">
          <label>每人分摊多少（元）</label>
          {activeMembers.map((m) => (
            <div key={m.id} className="custom-row">
              <span>{m.name}</span>
              <input
                inputMode="decimal"
                value={custom[m.id] ?? ''}
                placeholder="0.00"
                onChange={(e) => setCustom({ ...custom, [m.id]: e.target.value })}
              />
            </div>
          ))}
          <div className={`small ${amountCents !== null && customTotal !== amountCents ? 'text-warn' : 'faint'}`}>
            已分 {fmtMoney(customTotal)}
            {amountCents !== null && ` / 总额 ${fmtMoney(amountCents)}`}
            {amountCents !== null && customTotal !== amountCents &&
              `（还差 ${fmtMoney(amountCents - customTotal)}）`}
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="enote">备注（选填）</label>
        <input id="enote" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} />
      </div>

      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>

      {editing && editing.splitType === 'custom' && (
        <p className="small faint">
          这笔原来是按不同金额分的，改金额时请把每人的金额一并确认，否则总额会对不上。
        </p>
      )}
    </div>
  );
}
