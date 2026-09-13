import { useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner } from '../App';

type Mode = 'welcome' | 'register' | 'login' | 'pin-login' | 'join' | 'forgot' | 'codes';

interface LookupMember {
  id: string;
  name: string;
  claimed: boolean;
}

export default function AuthPage({ onAuthed }: { onAuthed: () => Promise<void> }) {
  const [mode, setMode] = useState<Mode>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 注册 / 登录
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');

  // 加入房间
  const [code, setCode] = useState('');
  const [looked, setLooked] = useState<{ name: string; members: LookupMember[] } | null>(null);
  const [joinName, setJoinName] = useState('');
  const [joinRoom, setJoinRoom] = useState('');

  // PIN 快捷登录
  const [pin, setPin] = useState('');
  const [pinCode, setPinCode] = useState('');
  const [pinLooked, setPinLooked] = useState<{ name: string; members: LookupMember[] } | null>(null);
  const [pickedMemberId, setPickedMemberId] = useState('');

  // 恢复码展示（注册后一次性）
  const [codes, setCodes] = useState<string[]>([]);

  function reset() {
    setError(null);
    setEmail('');
    setPassword('');
    setPassword2('');
    setCode('');
    setLooked(null);
    setJoinName('');
    setJoinRoom('');
    setPin('');
    setPinCode('');
    setPinLooked(null);
    setPickedMemberId('');
  }

  function go(next: Mode) {
    reset();
    setMode(next);
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

  const handleRegister = () =>
    run(async () => {
      if (password !== password2) throw new ApiError(0, '两次输入的密码不一致');
      const res = await api.register({ email: email.trim(), password });
      setCodes(res.recoveryCodes ?? []);
      setMode('codes');
    });

  const handleLogin = () =>
    run(async () => {
      await api.loginWithPassword({ email: email.trim(), password });
      await onAuthed();
    });

  const handleJoin = () =>
    run(async () => {
      if (password !== password2) throw new ApiError(0, '两次输入的密码不一致');
      const res = await api.join({
        inviteCode: code.trim(),
        name: joinName.trim(),
        room: joinRoom.trim() || undefined,
        email: email.trim(),
        password,
      });
      if (res.recoveryCodes?.length) {
        setCodes(res.recoveryCodes);
        setMode('codes');
        return;
      }
      await onAuthed();
    });

  const handlePinLookup = () =>
    run(async () => {
      const res = await api.lookupHousehold(pinCode.trim());
      setPinLooked({ name: res.household.name, members: res.members });
    });

  const handlePinLogin = (memberId: string) =>
    run(async () => {
      await api.loginWithPin({ inviteCode: pinCode.trim(), memberId, pin });
      await onAuthed();
    });

  const handleForgot = () =>
    run(async () => {
      if (password !== password2) throw new ApiError(0, '两次输入的新密码不一致');
      await api.resetWithRecoveryCode({
        email: email.trim(),
        code: code.trim(),
        newPassword: password,
      });
      go('login');
    });

  // ── 恢复码（只显示这一次）───────────────────────────────────────
  if (mode === 'codes') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">请保存你的恢复码</h1>
          <p className="auth-desc">
            忘记密码时，这是唯一的自助找回方式。**只显示这一次**，关掉就再也看不到了。
          </p>

          <div className="recovery-codes">
            {codes.map((c) => (
              <code key={c} className="recovery-code">
                {c}
              </code>
            ))}
          </div>

          <div className="alert alert-info">
            抄在纸上，或存进密码管理器。每个码只能用一次。之后也可以在「室友」页用密码换一批新的。
          </div>

          <button
            type="button"
            className="btn btn-block"
            onClick={() => {
              void onAuthed();
            }}
          >
            我已抄好，继续
          </button>
        </div>
      </div>
    );
  }

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
            onClick={() => go('register')}
          >
            注册新账号
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            style={{ marginBottom: 10 }}
            onClick={() => go('login')}
          >
            登录
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => go('join')}
          >
            用邀请码加入房间
          </button>

          <p className="auth-switch" style={{ marginTop: 20 }}>
            已经在这个房间设过 PIN？
            <button type="button" className="link" onClick={() => go('pin-login')}>
              用 PIN 快速登录
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 注册 ───────────────────────────────────────────────────────
  if (mode === 'register') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">注册</h1>
          <p className="auth-desc">注册后可以创建自己的房间，或用邀请码加入室友的房间</p>

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="re">邮箱</label>
            <input
              id="re"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="rp">密码</label>
            <input
              id="rp"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </div>

          <div className="field">
            <label htmlFor="rp2">再输一次</label>
            <input
              id="rp2"
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {/* 这一阶段没有域名、发不出验证邮件，所以邮箱只用来登录，
              任何功能都不以「邮箱已核实」为前提。写清楚免得用户以为要收信。 */}
          <div className="small faint" style={{ marginBottom: 12 }}>
            暂时不用邮箱验证，填一个你记得住的就行。邮箱只用于登录。
          </div>

          <button
            type="button"
            className="btn btn-block"
            disabled={busy || !email.trim() || password.length < 8 || !password2}
            onClick={handleRegister}
          >
            {busy ? '注册中…' : '注册'}
          </button>
          <p className="auth-switch">
            <button type="button" className="link" onClick={() => go('welcome')}>
              返回
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 忘记密码 ───────────────────────────────────────────────────
  if (mode === 'forgot') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">用恢复码重置密码</h1>

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="fe">邮箱</label>
            <input
              id="fe"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="fc">恢复码</label>
            <input
              id="fc"
              className="mono"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              maxLength={12}
            />
          </div>

          <div className="field">
            <label htmlFor="fp">新密码</label>
            <input
              id="fp"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </div>

          <div className="field">
            <label htmlFor="fp2">再输一次</label>
            <input
              id="fp2"
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          <div className="alert alert-info">
            重置成功后所有设备都会退出登录，需要用新密码重新登录。
          </div>

          <button
            type="button"
            className="btn btn-block"
            disabled={busy || !email.trim() || !code.trim() || password.length < 8}
            onClick={handleForgot}
          >
            {busy ? '重置中…' : '重置密码'}
          </button>
          <p className="auth-switch">
            <button type="button" className="link" onClick={() => go('login')}>
              返回登录
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── PIN 快捷登录 ───────────────────────────────────────────────
  if (mode === 'pin-login') {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="auth-title">PIN 快捷登录</h1>
          <p className="auth-desc">输入邀请码，选你的名字，再输 PIN</p>

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="pc">邀请码</label>
            <input
              id="pc"
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.toUpperCase())}
              placeholder="8 位邀请码"
              className="mono"
              maxLength={12}
              autoCapitalize="characters"
            />
          </div>

          {!pinLooked ? (
            <button
              type="button"
              className="btn btn-block"
              disabled={busy || pinCode.trim().length < 4}
              onClick={handlePinLookup}
            >
              {busy ? '查询中…' : '下一步'}
            </button>
          ) : (
            <>
              <div className="field">
                <label>你是谁？</label>
                <div className="member-grid">
                  {pinLooked.members
                    .filter((m) => m.claimed)
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
                {pinLooked.members.filter((m) => m.claimed).length === 0 && (
                  <div className="small faint" style={{ marginTop: 8 }}>
                    这个房间里还没有人绑定账号，先用邮箱注册再加入吧。
                  </div>
                )}
              </div>

              {pickedMemberId && (
                <>
                  <div className="field">
                    <label htmlFor="pp">PIN</label>
                    <input
                      id="pp"
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
                    onClick={() => handlePinLogin(pickedMemberId)}
                  >
                    {busy ? '登录中…' : '登录'}
                  </button>
                </>
              )}
            </>
          )}

          <p className="auth-switch">
            <button type="button" className="link" onClick={() => go('welcome')}>
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

          <ErrorBanner error={error} />

          <div className="field">
            <label htmlFor="le">邮箱</label>
            <input
              id="le"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="lpw">密码</label>
            <input
              id="lpw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          <button
            type="button"
            className="btn btn-block"
            disabled={busy || !email.trim() || !password}
            onClick={handleLogin}
          >
            {busy ? '登录中…' : '登录'}
          </button>

          <p className="auth-switch">
            <button type="button" className="link" onClick={() => go('forgot')}>
              忘记密码
            </button>
            <span className="faint"> · </span>
            <button type="button" className="link" onClick={() => go('welcome')}>
              返回
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── 用邀请码加入（新用户一步到位）───────────────────────────────
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
              onClick={() =>
                run(async () => {
                  const res = await api.lookupHousehold(code.trim());
                  setLooked({ name: res.household.name, members: res.members });
                })
              }
            >
              {busy ? '查询中…' : '下一步'}
            </button>
          </>
        ) : (
          <>
            <div className="alert alert-info">加入「{looked.name}」</div>

            {looked.members.filter((m) => !m.claimed).length > 0 && (
              <div className="small faint" style={{ marginBottom: 12 }}>
                室友已经替你建好了名字？
                {looked.members
                  .filter((m) => !m.claimed)
                  .map((m) => m.name)
                  .join('、')}
                ——在下面把「你的名字」填成完全一样，就会自动接上，历史账目不会断。
              </div>
            )}

            <div className="field">
              <label htmlFor="je">邮箱</label>
              <input
                id="je"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>

            <div className="field">
              <label htmlFor="jp">密码</label>
              <input
                id="jp"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
              />
            </div>

            <div className="field">
              <label htmlFor="jp2">再输一次</label>
              <input
                id="jp2"
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                autoComplete="new-password"
              />
            </div>

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

            <button
              type="button"
              className="btn btn-block"
              disabled={
                busy ||
                !joinName.trim() ||
                !email.trim() ||
                password.length < 8 ||
                password !== password2
              }
              onClick={handleJoin}
            >
              {busy ? '加入中…' : '加入房间'}
            </button>
          </>
        )}

        <p className="auth-switch">
          <button type="button" className="link" onClick={() => go('welcome')}>
            返回
          </button>
        </p>
      </div>
    </div>
  );
}
