/** 随机 ID 与邀请码生成。一律使用加密安全随机源，不用 Math.random。 */

/** 邀请码字符集：去掉 0/O/1/I/L 等易混字符，避免口头传达时传错。 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_LENGTH = 8;

/** 恢复码用同一套字符集，同样是手抄场景。 */
const RECOVERY_LENGTH = 8;

const ID_BYTES = 16;

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 从字符集里均匀取 n 个字符。
 *
 * 用拒绝采样而非 `random % 31`——直接取模会让字符集前几位出现的概率偏高
 * （31 不整除 256），削弱不可预测性。
 */
function randomFromAlphabet(length: number, alphabet: string): string {
  const max = 256 - (256 % alphabet.length); // 拒绝采样上界
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (out.length >= length) break;
      if (byte < max) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** 通用实体 ID（32 位十六进制）。 */
export function newId(): string {
  return toHex(randomBytes(ID_BYTES));
}

/** 邀请码。 */
export function newInviteCode(): string {
  return randomFromAlphabet(INVITE_LENGTH, INVITE_ALPHABET);
}

/**
 * 恢复码，形如 `XXXX-XXXX`。
 *
 * 8 位 × 31 种字符 ≈ 40 bit 熵，不存在被在线爆破的可能，
 * 因此存储时用一次 SHA-256 就够，不需要 PBKDF2（也就不碰 CPU 预算）。
 */
export function newRecoveryCode(): string {
  const raw = randomFromAlphabet(RECOVERY_LENGTH, INVITE_ALPHABET);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * 归一化邀请码 / 恢复码：去空格与连字符、转大写，容忍用户手抄时的格式差异。
 * 两个码共用这一套规则，所以函数名不绑定其中任何一个。
 */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}
