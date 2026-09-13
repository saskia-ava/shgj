import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  validateEmail,
  validatePassword,
  MIN_PASSWORD_LENGTH,
} from '../src/shared/email';

describe('normalizeEmail', () => {
  it('去空格并转小写', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(normalizeEmail('ann@example.com')).toBe('ann@example.com');
  });

  it('★ 不吞掉加号后缀和点号', () => {
    // 有些服务商把 a+tag@x.com 和 a@x.com 当同一个邮箱，但这是服务商自己的
    // 规则，不是邮箱的规则。照着去归一化会让两个本来不同的地址变成同一个
    // 身份——那意味着注册时可能被别人的账号挡住，或者更糟，登进别人的账号。
    expect(normalizeEmail('a+tag@example.com')).toBe('a+tag@example.com');
    expect(normalizeEmail('a.b@example.com')).not.toBe(normalizeEmail('ab@example.com'));
  });
});

describe('validateEmail', () => {
  it('接受常见合法邮箱', () => {
    for (const ok of [
      'a@b.co',
      'ann@example.com',
      'first.last@sub.example.com.cn',
      'x+tag@example.com',
      '123@qq.com',
    ]) {
      expect(validateEmail(ok)).toBeNull();
    }
  });

  it('拒绝明显不是邮箱的输入', () => {
    for (const bad of [
      '',
      '   ',
      'ann',
      'ann@',
      '@example.com',
      'ann@example',
      'ann@@example.com',
      'ann @example.com',
      'ann@example..com',
    ]) {
      expect(validateEmail(bad)).toBeTruthy();
    }
  });

  it('拒绝超长邮箱', () => {
    expect(validateEmail(`${'x'.repeat(250)}@example.com`)).toBeTruthy();
  });

  it('校验前先做归一化，所以大小写和空格不影响结果', () => {
    expect(validateEmail('  Ann@Example.COM ')).toBeNull();
  });
});

describe('validatePassword', () => {
  it('接受够长的密码，包括中文', () => {
    expect(validatePassword('12345678')).toBeNull();
    // 中文按字符数算：这句是 9 个字，够长
    expect(validatePassword('我家猫叫土豆啊真可爱')).toBeNull();
    expect(validatePassword('x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('拒绝过短的密码', () => {
    expect(validatePassword('1234567')).toBeTruthy();
    expect(validatePassword('')).toBeTruthy();
  });

  it('拒绝非文本与首尾空格', () => {
    expect(validatePassword(12345678)).toBeTruthy();
    expect(validatePassword(null)).toBeTruthy();
    expect(validatePassword(' 12345678')).toBeTruthy();
    expect(validatePassword('12345678 ')).toBeTruthy();
  });

  it('拒绝超长密码——否则会把 PBKDF2 拖垮', () => {
    expect(validatePassword('x'.repeat(129))).toBeTruthy();
  });
});
