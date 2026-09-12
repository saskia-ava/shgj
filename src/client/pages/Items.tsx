import { useCallback, useEffect, useState } from 'react';
import { api, type Item } from '../api';
import { ErrorBanner } from '../App';
import { fmtRelativeDate } from '../format';

export default function Items() {
  const [list, setList] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState('');
  const [minQuantity, setMinQuantity] = useState('1');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editMin, setEditMin] = useState('');

  const load = useCallback(async () => {
    try {
      const { items } = await api.listItems();
      setList(items);
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

  // 用 delta 而不是直接设值：两个人同时点「用掉一个」时，
  // 服务端做 quantity = MAX(0, quantity + delta)，两次点击都会生效，不会丢一次。
  const bump = (item: Item, delta: number) =>
    act(() => api.updateItem(item.id, { delta }))();

  const add = () =>
    act(async () => {
      await api.createItem({
        name: name.trim(),
        quantity: Number(quantity) || 0,
        unit: unit.trim() || undefined,
        minQuantity: Number(minQuantity) || 0,
      });
      setName('');
      setQuantity('1');
      setUnit('');
      setMinQuantity('1');
      setShowAdd(false);
    })();

  // 返回的是「处理器」而不是调用结果：直接写 onClick={saveEdit(id)} 会在渲染时
  // 立刻执行保存，而不是等点击。
  const saveEdit = (id: string) =>
    act(async () => {
      await api.updateItem(id, {
        name: editName.trim(),
        unit: editUnit.trim() || '',
        minQuantity: Number(editMin) || 0,
      });
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

  const needsRestock = list.filter((i) => i.needsRestock);
  const fine = list.filter((i) => !i.needsRestock);

  const renderItem = (item: Item) => (
    <div key={item.id} className={`card item-card${item.needsRestock ? ' card-warn' : ''}`}>
      {editingId === item.id ? (
        <>
          <div className="row">
            <div className="field">
              <label htmlFor={`in-${item.id}`}>名称</label>
              <input
                id={`in-${item.id}`}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={30}
              />
            </div>
            <div className="field">
              <label htmlFor={`iu-${item.id}`}>单位</label>
              <input
                id={`iu-${item.id}`}
                value={editUnit}
                onChange={(e) => setEditUnit(e.target.value)}
                placeholder="卷 / 瓶 / 包"
                maxLength={10}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`im-${item.id}`}>低于多少算该补货</label>
            <input
              id={`im-${item.id}`}
              type="number"
              min={0}
              value={editMin}
              onChange={(e) => setEditMin(e.target.value)}
            />
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !editName.trim()}
              onClick={saveEdit(item.id)}
            >
              保存
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="card-head">
            <div style={{ minWidth: 0 }}>
              <h2 className="card-title">{item.name}</h2>
              <p className="card-sub">
                {item.needsRestock ? '该补货了' : '够用'}
                {item.minQuantity > 0 && ` · 低于 ${item.minQuantity} 提醒`}
                {` · ${fmtRelativeDate(item.updatedAt)}更新`}
              </p>
            </div>
            <div className={`qty${item.needsRestock ? ' qty-low' : ''}`}>
              {item.quantity}
              {item.unit && <span className="qty-unit">{item.unit}</span>}
            </div>
          </div>

          {item.note && <p className="small faint">{item.note}</p>}

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => bump(item, 1)}
              title="加一个"
            >
              +1
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || item.quantity === 0}
              onClick={() => bump(item, -1)}
              title="用掉一个"
            >
              −1
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditingId(item.id);
                setEditName(item.name);
                setEditUnit(item.unit ?? '');
                setEditMin(String(item.minQuantity));
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={act(() => api.deleteItem(item.id))}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <>
      <ErrorBanner error={error} />

      {needsRestock.length > 0 && (
        <div className="alert alert-warn">
          有 {needsRestock.length} 样东西该补货了：{needsRestock.map((i) => i.name).join('、')}
        </div>
      )}

      {!showAdd ? (
        <button type="button" className="btn btn-block" onClick={() => setShowAdd(true)}>
          + 添加公共物品
        </button>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">添加公共物品</h2>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="itn">名称</label>
              <input
                id="itn"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：抽纸"
                maxLength={30}
              />
            </div>
            <div className="field">
              <label htmlFor="itu">单位（选填）</label>
              <input
                id="itu"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="包 / 卷 / 瓶"
                maxLength={10}
              />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="itq">现有数量</label>
              <input
                id="itq"
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="itm">低于多少提醒补货</label>
              <input
                id="itm"
                type="number"
                min={0}
                value={minQuantity}
                onChange={(e) => setMinQuantity(e.target.value)}
              />
            </div>
          </div>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy || !name.trim()} onClick={add}>
              添加
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
            <div className="empty-icon">🧻</div>
            <div className="empty-title">还没有登记公共物品</div>
            <div className="empty-desc">纸巾、洗洁精这类共用的东西，记在这里就不会突然用完没人管</div>
          </div>
        </div>
      ) : (
        <>
          {needsRestock.length > 0 && (
            <>
              <div className="section-title">该补货（{needsRestock.length}）</div>
              {needsRestock.map(renderItem)}
            </>
          )}
          {fine.length > 0 && (
            <>
              <div className="section-title">够用（{fine.length}）</div>
              {fine.map(renderItem)}
            </>
          )}
        </>
      )}

      <p className="small faint" style={{ marginTop: 12 }}>
        数量用「+1 / −1」加减而不是直接改数字，这样两个人同时用掉一件时不会互相覆盖。
      </p>
    </>
  );
}
