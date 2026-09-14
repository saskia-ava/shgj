import { useState } from 'react';

/**
 * 邀请码展示 + 复制。原样搬自「室友」页那块，加了一个真的复制按钮。
 *
 * 原来只有一句「点一下可以选中复制」——靠 `user-select: all` 让人手动
 * Ctrl+C。手机上长按选中 8 位码并不好操作，而这恰恰是最常用的动作
 * （把码发到微信群里），所以补一个按钮。
 *
 * `navigator.clipboard` 只在**安全上下文**（HTTPS 或 localhost）可用。
 * 线上是 HTTPS、本地是 localhost，都满足，但失败也必须有个能用的兜底，
 * 不能点了没反应——所以失败时退回「选中文本 + 提示按 Ctrl+C」。
 */
export default function InviteBox({ code, householdName }: { code: string; householdName: string }) {
  const [hint, setHint] = useState('把邀请码发给室友，他们就能加入');

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setHint('已复制，发到群里就行');
    } catch {
      // 退回手动选中。这里不能吞掉——用户点了按钮必须看到发生了什么。
      const el = document.getElementById('invite-code-text');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setHint('已选中，按 Ctrl+C（Mac 是 ⌘C）复制');
    }
  }

  return (
    <div className="invite-box">
      <div className="invite-hint">
        {householdName} · 把邀请码发给室友，他们就能加入
      </div>
      <div className="invite-code" id="invite-code-text">
        {code}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => void copy()}>
        复制邀请码
      </button>
      <div className="invite-hint" style={{ marginTop: 6 }}>
        {hint}
      </div>
    </div>
  );
}
