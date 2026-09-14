import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner, useApp } from '../App';

/**
 * 设置 / 修改「我在这个房间」的 PIN。原样搬自「室友」页那一节。
 *
 * 取 `hasPin` 走 useApp() 而不是接一个 prop：`members` 是 App 统一维护的，
 * 改完 PIN 调 `reloadMembers()` 会让这里和「室友」页同时刷新，
 * 不需要各自存一份状态再想办法同步。
 */
export default function PinForm() {
  const { session, members, reloadMembers } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');

  const me = members.find((m) => m.id === session.member.id);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // PIN 归「当前房间里的自己」所有，端点不收成员 id。
      // 已设过 PIN 就必须带 currentPin——服务端据此判断这是本人在改，
      // 不是捡到邀请码的人顺手把别人的 PIN 改掉。
      await api.setPin({
        pin: newPin,
        ...(me?.hasPin ? { currentPin: oldPin } : {}),
      });
      setOldPin('');
      setNewPin('');
      await reloadMembers();
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorBanner error={error} />

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
      <button
        type="button"
        className="btn btn-block"
        disabled={busy || newPin.length < 4 || (me?.hasPin && !oldPin)}
        onClick={() => void save()}
      >
        {busy ? '保存中…' : me?.hasPin ? '修改 PIN' : '设置 PIN'}
      </button>

      <p className="small faint" style={{ marginTop: 10 }}>
        PIN 是<strong>这个房间里</strong>的快捷登录方式：输邀请码 + 选自己的名字 + 输 PIN 就能进，
        不用打邮箱密码。它绑在「你在这个房间的身份」上，所以换个房间要重新设。
        <br />
        忘记 PIN 不会丢账号——用邮箱密码照样能登进来，在这里重设一个就行。
        PIN 只是快，不是唯一入口。
      </p>
    </>
  );
}
