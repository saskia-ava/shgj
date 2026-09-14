import { useEffect, useRef, type RefObject } from 'react';

/**
 * 浮层的公共行为：Esc 关闭、点外面关闭、打开时把焦点移进来并锁住、
 * 关闭后把焦点还回去。
 *
 * 抽出来是因为现在有**两个**浮层（顶栏头像菜单、＋ 房间弹窗），
 * 而这四件事每一件都容易漏、漏了又不容易发现：
 *   - 少了 Esc：键盘用户出不去
 *   - 少了锁焦点：按 Tab 会跑到浮层后面被遮住的页面上，视觉上完全看不出来
 *   - 少了「关掉后还焦点」：焦点瞬间掉到 <body>，键盘用户丢失位置
 *   - 少了「忽略触发按钮」：点触发按钮时它会先当作「点外面」关掉、
 *     再被 onToggle 打开，看起来就是关不上
 */
export function useDismissable({
  ref,
  onClose,
  /** 触发按钮。它不算「外面」——否则点击会先关闭再被重新打开。 */
  ignoreRef,
  /** 传 false 表示由调用方自己处理点外面（比如靠遮罩层的 onClick）。 */
  closeOnOutsideClick = true,
  /**
   * 是否把 Tab 锁在浮层内。
   * ⚠️ 只有写了 `aria-modal="true"` 的**模态**才必须开。普通下拉菜单
   *    锁焦点反而碍事（用户想 Tab 到下一个控件），所以默认关。
   */
  trapFocus = false,
}: {
  ref: RefObject<HTMLElement | null>;
  onClose: () => void;
  ignoreRef?: RefObject<HTMLElement | null>;
  closeOnOutsideClick?: boolean;
  trapFocus?: boolean;
}) {
  /*
   * ⚠️ onClose 走 ref，**不能**进下面那个 effect 的依赖数组。
   *    调用方十有八九是这么传的：`onClose={() => setOpen(false)}` ——
   *    每次渲染都是新函数。进了依赖数组，effect 就会在**每次渲染**时
   *    卸载重装，而它开头有一句「把焦点移进浮层」：于是你在面板里每敲一个
   *    字符，焦点就被拽回第一个输入框，中文输入法还会被直接打断。
   *    这个 bug 的症状（「打字打不进去」）离原因非常远，所以在这里挡掉。
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // 打开前焦点在哪。关闭时要还回去，否则焦点掉到 <body>，
    // 键盘用户得从头 Tab 一遍才能找回原来的位置。
    const previous = document.activeElement as HTMLElement | null;

    // 焦点移进浮层。优先第一个可聚焦元素（输入框），没有就落在容器上。
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

    const first = focusables()[0];
    if (first) first.focus();
    else node.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !trapFocus) return;

      const items = focusables();
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === head || active === node)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (node.contains(target)) return;
      if (ignoreRef?.current?.contains(target)) return;
      closeRef.current();
    };

    document.addEventListener('keydown', onKey);
    if (closeOnOutsideClick) document.addEventListener('pointerdown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
      // 浮层已经卸载了，焦点不可能还在里面；直接还给触发按钮。
      previous?.focus?.();
    };
    // onClose 刻意不在依赖里，见上面 closeRef 的注释。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ignoreRef, closeOnOutsideClick, trapFocus]);
}
