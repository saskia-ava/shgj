/** 随机 ID 与邀请码生成。一律使用加密安全随机源，不用 Math.random。 */

/** 邀请码字符集：去掉 0/O/1/I/L 等易混字符，避免口头传达时传错。 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_LENGTH = 8;

const ID_BYTES = 16;

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 通用实体 ID（32 位十六进制）。 */
export function newId(): string {
  return toHex(randomBytes(ID_BYTES));
}

/**
 * 邀请码。
 *
 * 用拒绝采样而非 `random % 31`——直接取模会让字符集前几位出现的概率偏高
 * （31 不整除 256），削弱邀请码的不可预测性。
 */
export function newInviteCode(): string {
  const max = 256 - (256 % INVITE_ALPHABET.length); // 拒绝采样上界
  let code = '';
  while (code.length < INVITE_LENGTH) {
    for (const byte of randomBytes(INVITE_LENGTH * 2)) {
      if (code.length >= INVITE_LENGTH) break;
      if (byte < max) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
    }
  }
  return code;
}

/** 归一化邀请码：去空格、转大写，容忍用户手输时的格式差异。 */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}
