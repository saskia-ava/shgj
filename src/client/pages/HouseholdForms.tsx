import { useId, useState } from 'react';
import { api } from '../api';
import { ErrorBanner } from '../App';

/**
 * 建房 / 加入房间的表单。被两处复用，**只有这一份实现**：
 *
 *   1. `HouseholdGate` —— 已登录但当前房间下没有身份时的中转页
 *   2. `App` 顶栏的「＋ 房间」弹窗 —— 已经有房间的人想再开一个
 *
 * ⚠️ 第二个入口是后补的。在此之前 `createHousehold` 只有 HouseholdGate 一个
 *    调用点，而 HouseholdGate 只在「没有活跃房间」时才渲染；同时顶栏的切换
 *    下拉框又只在 `households.length > 1` 时出现。两条加起来的效果是：
 *    **已经在一个房间里的人，没有任何办法从界面再建/加入第二个房间**——
 *    而服务端早就支持了（已登录时 `/auth/household` 和 `/auth/join` 都会
 *    `setActiveHousehold` 把会话切过去，见 auth.ts:541 和 auth.ts:671）。
 *    缺的纯粹是入口。
 *
 * 这里只渲染字段和按钮，标题 / 说明由调用方给——中转页要 `auth-title`，
 * 弹窗要弹窗自己的标题，共用一个写死的标题会别扭。
 */

/** busy / error 的样板，两个表单都一样，抽出来免得复制两份。 */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

  return { busy, error, run };
}

export function CreateHouseholdForm({ onDone }: { onDone: () => Promise<void> }) {
  const [householdName, setHouseholdName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [room, setRoom] = useState('');
  const { busy, error, run } = useSubmit();

  // useId 而不是写死 "hh"/"hn"/"hr"：同一个页面里万一同时挂载两个实例
  // （比如以后把弹窗改成不关闭的抽屉），写死的 id 会让 label 指到第一个
  // 实例上去——点标签跳到错误的输入框。
  const uid = useId();

  return (
    <>
      <ErrorBanner error={error} />

      <div className="field">
        <label htmlFor={`${uid}-hh`}>房间名</label>
        <input
          id={`${uid}-hh`}
          value={householdName}
          onChange={(e) => setHouseholdName(e.target.value)}
          placeholder="例如：望京西园三区 502"
          maxLength={30}
        />
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor={`${uid}-hn`}>你在房间里的名字</label>
          <input
            id={`${uid}-hn`}
            value={memberName}
            onChange={(e) => setMemberName(e.target.value)}
            placeholder="例如：小明"
            maxLength={20}
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-hr`}>房间（选填）</label>
          <input
            id={`${uid}-hr`}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="例如：主卧"
            maxLength={20}
          />
        </div>
      </div>

      <div className="small faint" style={{ marginBottom: 12 }}>
        建好之后会给你一个邀请码，室友用它加入。
      </div>

      <button
        type="button"
        className="btn btn-block"
        disabled={busy || !householdName.trim() || !memberName.trim()}
        onClick={() =>
          run(async () => {
            await api.createHousehold({
              householdName: householdName.trim(),
              memberName: memberName.trim(),
              room: room.trim() || undefined,
            });
            await onDone();
          })
        }
      >
        {busy ? '创建中…' : '创建房间'}
      </button>
    </>
  );
}

export function JoinHouseholdForm({ onDone }: { onDone: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [looked, setLooked] = useState<{
    name: string;
    members: { id: string; name: string; claimed: boolean }[];
  } | null>(null);
  const [memberName, setMemberName] = useState('');
  const [room, setRoom] = useState('');
  const { busy, error, run } = useSubmit();

  const uid = useId();
  const claimable = looked?.members.filter((m) => !m.claimed) ?? [];

  if (!looked) {
    return (
      <>
        <ErrorBanner error={error} />

        <p className="auth-desc">输入室友给你的邀请码</p>

        <div className="field">
          <label htmlFor={`${uid}-code`}>邀请码</label>
          <input
            id={`${uid}-code`}
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
    );
  }

  return (
    <>
      <ErrorBanner error={error} />

      <div className="alert alert-info">加入「{looked.name}」</div>

      {/* 认领已有档案的提示。**不能省**：室友可能早就替你建好了名字并把
          账记在上面，名字填得不一样就会新建一条档案，历史账目留在旧档案上，
          从此对不平——而用户不会知道发生了什么。 */}
      {claimable.length > 0 && (
        <div className="small faint" style={{ marginBottom: 12 }}>
          室友已经替你建好了名字？
          {claimable.map((m) => m.name).join('、')}
          ——把名字填成完全一样，就会接上已有的档案，历史账目不会断。
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor={`${uid}-name`}>你的名字</label>
          <input
            id={`${uid}-name`}
            value={memberName}
            onChange={(e) => setMemberName(e.target.value)}
            maxLength={20}
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-room`}>房间（选填）</label>
          <input
            id={`${uid}-room`}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            maxLength={20}
          />
        </div>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            setLooked(null);
          }}
        >
          换一个邀请码
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          disabled={busy || !memberName.trim()}
          onClick={() =>
            run(async () => {
              await api.join({
                inviteCode: code.trim(),
                name: memberName.trim(),
                room: room.trim() || undefined,
              });
              await onDone();
            })
          }
        >
          {busy ? '加入中…' : '加入房间'}
        </button>
      </div>
    </>
  );
}
