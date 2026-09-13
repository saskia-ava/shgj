/**
 * 邮箱与密码的格式校验。前后端共用：前端用于即时提示，后端用于把关。
 *
 * 前端校验只是为了体验，**后端的校验才是有效的那一道**——任何人都能
 * 绕过前端直接调接口。
 */

/** 密码长度下限。 */
export const MIN_PASSWORD_LENGTH = 8;
/** 密码长度上限。设上限是为了避免有人用超长输入拖垮 PBKDF2。 */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * 归一化邮箱：去掉首尾空格并转小写。
 *
 * 唯一索引建在归一化后的值上，因此 `Ann@Example.com` 和 `ann@example.com`
 * 会被认作同一个账号。**不做**「去掉加号后缀」「去掉点号」这类更激进的
 * 归一化——那会让 `a.b@x.com` 和 `ab@x.com` 变成同一个身份，而它们在
 * 很多邮件服务商那里本来就是两个不同的邮箱。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 校验邮箱格式。刻意不用完整的 RFC 5322 正则——那长得没法读，还会误判。
 * 这里只挡住明显不是邮箱的输入，真正的验证手段是往这个地址发一封信。
 */
export function validateEmail(email: string): string | null {
  const value = normalizeEmail(email);
  if (!value) return '请填写邮箱';
  if (value.length > 254) return '邮箱过长';
  // 本地部分@域名，域名至少有一个点且点两侧非空
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return '邮箱格式不正确';
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return '密码必须是文本';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `密码最多 ${MAX_PASSWORD_LENGTH} 位`;
  }
  if (password.trim() !== password) return '密码首尾不能有空格';
  return null;
}
