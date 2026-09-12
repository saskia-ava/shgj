import { useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner } from '../App';

type Mode = 'welcome' | 'create' | 'join' | 'login';

interface LookupMember {
  id: string;
  name: string;
  hasPin: boolean;
}

export default function AuthPage({ onAuthed }: { onAuthed: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 创建房间
  const [householdName, setHouseholdName] = useState('我们的合租房');
  const [createName, setCreateName] = useState('');
  const [createRoom, setCreateRoom] = useState('');
  const [createPin, setCreatePin] = useState('');
  const [createPin2, setCreatePin2] = useState('');

  // 加入 / 登录
  const [code, setCode] = useState('');
  const [looked, setLooked] = useState<{ name: string; members: LookupMember[] } | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joinRoom, setJoinRoom] = useState('');
  const [pin, setPin] = useState('');
  const [pickedMemberId, setPickedMemberId] = useState('');

  function reset() {
    setError(null);
    setCode('');
    setLooked(null);
    setJoinName('');
    setJoinRoom('');
    setPin('');
    setPickedMemberId('');
  }

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

  const handleCreate = () =>
    run(async () => {
      if (createPin !== createPin2) {
        throw new ApiError(0, '两次输入的 PIN 不一致');
      }
      await api.createHousehold({
        householdName: householdName.trim() || '我们的合租房',
        memberName: createName.trim(),
        room: createRoom.trim() || undefined,
        pin: createPin,
      });
      await onAuthed();
    });

  const handleLookup = () =>
    run(async () => {
      const res = await api.lookupHousehold(code.trim());
      setLooked({ name: res.household.name, members: res.members });
    });

  const handleJoin = () =>
    run(async () => {
      await api.join({
        inviteCode: code.trim(),
        name: joinName.trim(),
        room: joinRoom.trim() || undefined,
        pin,
      });
      await onAuthed();
    });

  const handleClaim = (member: LookupMember) =>
    run(async () => {
      await api.join({ inviteCode: code.trim(), name: member.name, pin });
      await onAuthed();
    });

  const handleLogin = (memberId: string) =>
    run(async () => {
      await api.login({ inviteCode: code.trim(), memberId, pin });
      await onAuthed();
    });

  // ── 欢迎页 ─────────────────────────────────────────────────────
  if (mode === 'welcome') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-logo">🏠</div>
          <h1 className="auth-title">合租生活管家</h1>
          <p className="auth-desc">记账分摊 · 值日排班 · 公告与公共物品</p>

          <button
            type="button"
            className="btn btn-block"
            style={{ marginBottom: 10 }}
            onClick={() => {
              reset();
              setMode('create');
            }}
          >
            创建新房间
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => {
              reset();
              setMode('join');
            }}
          >
            加入已有房间
          </button>

          <p className="auth-switch" style={{ marginTop: 20 }}>
            已经是成员了？
            <button
              type="button"
              className="link"
              onClick={() => {
                reset();
                setMode('login');
              }}
            >
              直接登录
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 创建房间 ───────────────────────────────────────────────────
  if (mode === 'create') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">创建新房间</h1>
          <p className="auth-desc">创建后会生成一个邀请码，发给室友即可加入</p>

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="hh">房间名称</label>
            <input
              id="hh"
              value={householdName}
              onChange={(e) => setHouseholdName(e.target.value)}
              placeholder="例如：幸福小区 3 栋 502"
              maxLength={30}
            />
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="mn">你的名字</label>
              <input
                id="mn"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="例如：小明"
                maxLength={20}
              />
            </div>
            <div className="field">
              <label htmlFor="rm">你住的房间（选填）</label>
              <input
                id="rm"
                value={createRoom}
                onChange={(e) => setCreateRoom(e.target.value)}
                placeholder="例如：主卧"
                maxLength={20}
              />
            </div>
          </div>

          <div className="row">
            <div className="field">
              <label htmlFor="p1">设置 PIN</label>
              <input
                id="p1"
                type="password"
                value={createPin}
                onChange={(e) => setCreatePin(e.target.value)}
                placeholder="至少 4 位"
                autoComplete="new-password"
              />
            </div>
            <div className="field">
              <label htmlFor="p2">再输一次</label>
              <input
                id="p2"
                type="password"
                value={createPin2}
                onChange={(e) => setCreatePin2(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="alert alert-info">
            想更安全的话，PIN 可以用一句好记的话（比如「我家猫叫土豆」），
            比 4 位数字难猜得多。
          </div>

          <button
            type="button"
            className="btn btn-block"
            disabled={busy || !createName.trim() || createPin.length < 4}
            onClick={handleCreate}
          >
            {busy ? '创建中…' : '创建房间'}
          </button>
          <p className="auth-switch">
            <button type="button" className="link" onClick={() => setMode('welcome')}>
              返回
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 登录 ───────────────────────────────────────────────────────
  if (mode === 'login') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">登录</h1>
          <p className="auth-desc">输入邀请码，选择你的名字</p>

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="lc">邀请码</label>
            <input
              id="lc"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="8 位邀请码"
              className="mono"
              maxLength={12}
              autoCapitalize="characters"
            />
          </div>

          {!looked ? (
            <button
              type="button"
              className="btn btn-block"
              disabled={busy || code.trim().length < 4}
              onClick={handleLookup}
            >
              {busy ? '查询中…' : '下一步'}
            </button>
          ) : (
            <>
              <div className="field">
                <label>你是谁？</label>
                <div className="member-grid">
                  {looked.members
                    .filter((m) => m.hasPin)
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`member-chip${pickedMemberId === m.id ? ' on' : ''}`}
                        onClick={() => setPickedMemberId(m.id)}
                      >
                        {m.name}
                      </button>
                    ))}
                </div>
                {looked.members.filter((m) => m.hasPin).length === 0 && (
                  <div className="small faint" style={{ marginTop: 8 }}>
                    还没有人设置过 PIN。请改用「加入已有房间」。
                  </div>
                )}
              </div>

              {pickedMemberId && (
                <>
                  <div className="field">
                    <label htmlFor="lp">PIN</label>
                    <input
                      id="lp"
                      type="password"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      autoComplete="current-password"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-block"
                    disabled={busy || !pin}
                    onClick={() => handleLogin(pickedMemberId)}
                  >
                    {busy ? '登录中…' : '登录'}
                  </button>
                </>
              )}
            </>
          )}

          <p className="auth-switch">
            <button
              type="button"
              className="link"
              onClick={() => {
                reset();
                setMode('welcome');
              }}
            >
              返回
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 加入房间 ───────────────────────────────────────────────────
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1 className="auth-title">加入房间</h1>

        <ErrorBanner error={error} />

        {!looked ? (
          <>
            <p className="auth-desc">输入室友给你的邀请码</p>
            <div className="field">
              <label htmlFor="jc">邀请码</label>
              <input
                id="jc"
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
              onClick={handleLookup}
            >
              {busy ? '查询中…' : '下一步'}
            </button>
          </>
        ) : (
          <>
            <div className="alert alert-info">加入「{looked.name}」</div>

            {looked.members.filter((m) => !m.hasPin).length > 0 && (
              <>
                <div className="field">
                  <label>已有你的名字？点一下认领</label>
                  <div className="member-grid">
                    {looked.members
                      .filter((m) => !m.hasPin)
                      .map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="member-chip"
                          disabled={pin.length < 4}
                          title={pin.length < 4 ? '先在下面设置 PIN' : ''}
                          onClick={() => handleClaim(m)}
                        >
                          {m.name}
                          <span className="chip-sub">认领</span>
                        </button>
                      ))}
                  </div>
                  <div className="small faint" style={{ marginTop: 6 }}>
                    先设置下面的 PIN，再点名字认领。
                  </div>
                </div>
                <div className="section-title" style={{ marginTop: 16 }}>
                  或者以新成员加入
                </div>
              </>
            )}

            <div className="row">
              <div className="field">
                <label htmlFor="jn">你的名字</label>
                <input
                  id="jn"
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  maxLength={20}
                />
              </div>
              <div className="field">
                <label htmlFor="jr">房间（选填）</label>
                <input
                  id="jr"
                  value={joinRoom}
                  onChange={(e) => setJoinRoom(e.target.value)}
                  maxLength={20}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="jp">设置你的 PIN</label>
              <input
                id="jp"
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="至少 4 位"
                autoComplete="new-password"
              />
            </div>

            <button
              type="button"
              className="btn btn-block"
              disabled={busy || !joinName.trim() || pin.length < 4}
              onClick={handleJoin}
            >
              {busy ? '加入中…' : '加入房间'}
            </button>
          </>
        )}

        <p className="auth-switch">
          <button
            type="button"
            className="link"
            onClick={() => {
              reset();
              setMode('welcome');
            }}
          >
            返回
          </button>
        </p>
      </div>
    </div>
  );
}
