import { useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorBanner } from '../App';

/**
 * 账号层面的安全设置：改密码、重设恢复码。
 *
 * 这两件事都作用在**账号**上，跟当前在哪个房间无关。
 *
 * ⚠️ 界面上的位置变过，逻辑一行没动。原来它挂在「室友」页底部，
 *    现在从顶栏头像菜单的「修改密码」进——所以多了个 `embedded`：
 *    菜单面板自带标题和容器，再渲染一层 `.section-title` + `.card`
 *    会套娃；而且面板本身就是「已经展开」的状态，再给一个
 *    「修改密码 / 重设恢复码」的折叠按钮纯属多余。
 */
export default function AccountSecurity({ embedded = false }: { embedded?: boolean }) {
  const [open, setOpen] = useState(embedded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [done, setDone] = useState(false);

  // 新生成的恢复码。只在这一屏显示，切走就没了。
  const [codes, setCodes] = useState<string[]>([]);
  const [rcPwd, setRcPwd] = useState('');
  const [rcOpen, setRcOpen] = useState(false);

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

  const changePassword = () =>
    run(async () => {
      if (next !== next2) throw new ApiError(0, '两次输入的新密码不一致');

      // 两步是**故意的**，不是没合并。合起来一个请求要跑两次 PBKDF2
      // （验旧的 + 算新的），叠加后贴着 Workers 免费版 10ms 的 CPU 上限。
      // 拆开之后两条路径各只有一次；代价就是这里必须写两行。
      await api.verifyPassword(cur);
      await api.changePassword(next);

      setCur('');
      setNext('');
      setNext2('');
      setDone(true);
    });

  const regenerate = () =>
    run(async () => {
      const res = await api.regenerateRecoveryCodes(rcPwd);
      setCodes(res.recoveryCodes);
      setRcPwd('');
      setRcOpen(false);
    });

  const body = (
    <>
      <ErrorBanner error={error} />

      {!open ? (
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setOpen(true)}>
          修改密码 / 重设恢复码
        </button>
      ) : (
        <>
          {done ? (
            <div className="alert alert-info">
              密码已修改。其它设备上的登录都已失效，需要用新密码重新登录。
              <button
                type="button"
                className="link"
                style={{ marginLeft: 8 }}
                onClick={() => setDone(false)}
              >
                再改一次
              </button>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="cap">当前密码</label>
                <input
                  id="cap"
                  type="password"
                  value={cur}
                  onChange={(e) => setCur(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="field">
                <label htmlFor="cnp">新密码</label>
                <input
                  id="cnp"
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder="至少 8 位"
                  autoComplete="new-password"
                />
              </div>
              <div className="field">
                <label htmlFor="cnp2">再输一次</label>
                <input
                  id="cnp2"
                  type="password"
                  value={next2}
                  onChange={(e) => setNext2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !cur || next.length < 8 || next !== next2}
                  onClick={changePassword}
                >
                  {busy ? '提交中…' : '修改密码'}
                </button>
                {/* embedded 时面板自己有返回键，不需要这个「收起」 */}
                {!embedded && (
                  <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                    收起
                  </button>
                )}
              </div>
            </>
          )}

          <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid var(--border)' }} />

          {codes.length > 0 ? (
            <>
              <p className="small faint" style={{ marginTop: 0 }}>
                这是你的新恢复码，<strong>旧的一批已经全部作废</strong>。只显示这一次。
              </p>
              <div className="recovery-codes">
                {codes.map((c) => (
                  <code key={c} className="recovery-code">
                    {c}
                  </code>
                ))}
              </div>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => setCodes([])}>
                我已抄好
              </button>
            </>
          ) : !rcOpen ? (
            <>
              <p className="small faint" style={{ marginTop: 0 }}>
                恢复码是忘记密码时<strong>唯一</strong>的自助找回方式。注册时给过你 8 个，
                如果弄丢了或者不确定还在不在，用密码换一批新的。
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => setRcOpen(true)}
              >
                重设恢复码
              </button>
            </>
          ) : (
            <>
              <div className="alert alert-error">
                点了之后旧的一批立刻作废，无论你有没有把新的抄下来。确认旧的已经没用了再继续。
              </div>
              <div className="field">
                <label htmlFor="rcp">当前密码</label>
                <input
                  id="rcp"
                  type="password"
                  value={rcPwd}
                  onChange={(e) => setRcPwd(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="btn-row">
                <button type="button" className="btn" disabled={busy || !rcPwd} onClick={regenerate}>
                  {busy ? '生成中…' : '确定，作废旧的'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setRcOpen(false)}>
                  取消
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <>
      <div className="section-title">账号安全</div>
      <div className="card">{body}</div>
    </>
  );
}
