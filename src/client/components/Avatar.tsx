import { AVATAR_IDS } from '../../shared/avatars';

/**
 * 圆形头像。两种来源，按同一套尺寸渲染：
 *   - 设过：白名单 id → emoji + 配色
 *   - 没设过（null / 未知 id）：名字首字母 + 由名字算出的稳定配色
 *
 * ⚠️ 首字母兜底**必须由名字算颜色**，不能随机、也不能固定一个灰。
 *    随机的话每次重渲染都换一个色，页面会闪；固定灰的话一屋子人全是灰球，
 *    等于没有头像。用名字哈希取模，同一个人永远同一个色，不同的人大概率不同。
 */

/** id → emoji + 背景色。配色是表现层的事，所以不放进 shared/。 */
const PRESETS: Record<string, { emoji: string; bg: string }> = {
  cat: { emoji: '🐱', bg: '#fef3c7' },
  dog: { emoji: '🐶', bg: '#ffedd5' },
  fox: { emoji: '🦊', bg: '#fed7aa' },
  panda: { emoji: '🐼', bg: '#e5e7eb' },
  bear: { emoji: '🐻', bg: '#fde68a' },
  rabbit: { emoji: '🐰', bg: '#fce7f3' },
  penguin: { emoji: '🐧', bg: '#dbeafe' },
  koala: { emoji: '🐨', bg: '#e0e7ff' },
  tiger: { emoji: '🐯', bg: '#fee2e2' },
  whale: { emoji: '🐳', bg: '#cffafe' },
  cactus: { emoji: '🌵', bg: '#dcfce7' },
  sunflower: { emoji: '🌻', bg: '#fef9c3' },
  avocado: { emoji: '🥑', bg: '#d9f99d' },
  coffee: { emoji: '☕', bg: '#e7d3c0' },
  rocket: { emoji: '🚀', bg: '#e9d5ff' },
  moon: { emoji: '🌙', bg: '#ddd6fe' },
};

/** 首字母兜底的底色。挑中低饱和度，白字压得住。 */
const FALLBACK_BG = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * 取首字母。
 *
 * 用 `Array.from` 而不是 `name[0]`：后者对 emoji 和部分汉字会切出半个
 * 代理对，渲染成一个乱码方块。中文名取第一个字，英文名取第一个字母
 * （大写）。
 */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? '?';
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

export function avatarStyle(value: string | null | undefined, name: string) {
  const preset = value ? PRESETS[value] : undefined;
  if (preset) return { background: preset.bg, content: preset.emoji, isEmoji: true };

  return {
    background: FALLBACK_BG[hashCode(name) % FALLBACK_BG.length],
    content: initialOf(name),
    isEmoji: false,
  };
}

/** 给「更换头像」的九宫格用：所有可选预设，顺序固定。 */
export const AVATAR_PRESET_LIST = AVATAR_IDS.map((id) => ({
  id,
  emoji: PRESETS[id].emoji,
  bg: PRESETS[id].bg,
}));

export default function Avatar({
  value,
  name,
  size = 32,
  className,
}: {
  value: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
}) {
  const { background, content, isEmoji } = avatarStyle(value, name);

  return (
    <span
      className={`avatar${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        background,
        // emoji 要小一号才不显得顶满，首字母反过来要够大才看得清
        fontSize: isEmoji ? Math.round(size * 0.55) : Math.round(size * 0.44),
      }}
      // 头像是纯装饰（名字就在旁边），对屏幕阅读器隐藏，免得每读一个成员
      // 就多念一句无意义的字符。
      aria-hidden="true"
    >
      {content}
    </span>
  );
}
