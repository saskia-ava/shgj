/**
 * 头像的**白名单**。服务端存的是这里的 id，不是 emoji 本身。
 *
 * 为什么不做上传图片：那需要 R2，而开 R2 要绑信用卡/PayPal（第三期卡在这）。
 * 把图片塞进 D1 更糟——每个 `/auth/me` 都要带上图片字节，`members` 行会被撑大，
 * 而 CPU 预算本来就紧。所以第一阶段只做「从一组预设里挑一个」，不需要任何
 * 外部依赖，今天就能用。
 *
 * 为什么存 id 而不是 emoji 本身：
 *   1. 白名单是**校验**。存任意字符串的话，服务端就得去判断「这是不是一个
 *      合法的 emoji、有没有夹带别的东西」，而这件事没有可靠的判法。
 *   2. 以后要加真人头像上传，值是 `url:<key>`，客户端按前缀分流，
 *      **不用再改一次数据库**。所以这里刻意不做「值必须等于某个 emoji」的假设。
 *
 * 客户端负责把 id 映射成 emoji + 背景色（见 components/Avatar.tsx）——
 * 配色是表现层的事，服务端不需要知道。
 */
export const AVATAR_IDS = [
  'cat',
  'dog',
  'fox',
  'panda',
  'bear',
  'rabbit',
  'penguin',
  'koala',
  'tiger',
  'whale',
  'cactus',
  'sunflower',
  'avocado',
  'coffee',
  'rocket',
  'moon',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

const VALID = new Set<string>(AVATAR_IDS);

/**
 * 校验一个头像值。
 *
 * `null` 是合法的，表示「没设过，用首字母兜底」——所以调用方要把
 * 「清空头像」和「传了非法值」分开处理：前者传 null，后者返回 false。
 */
export function isValidAvatar(value: unknown): value is AvatarId {
  return typeof value === 'string' && VALID.has(value);
}
