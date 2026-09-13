/**
 * 接口错误码。前后端共用：后端用它标注失败原因，前端据此决定怎么处理。
 *
 * 为什么 HTTP 状态码不够、还要单独一个 code：前端对「未登录」和「已登录但
 * 没有房间」的处理完全不同，但两者都可能是 401/403。只看状态码会分错流。
 * 最典型的是把 NO_MEMBERSHIP 当成会话过期处理——用户明明登录着，却被踢到
 * 登录页，而且**重登也回不去**，因为问题不在登录态。
 */
export type ErrorCode =
  | 'SESSION_EXPIRED' // 401 会话无效或过期 → 回登录页
  | 'NO_MEMBERSHIP' // 403 已登录但当前房间下没有在住档案 → 回房间选择页
  | 'INVALID_CREDENTIALS' // 401 账号或密码/PIN 不正确
  | 'EMAIL_TAKEN' // 409 邮箱已被注册
  | 'CLAIMED_ALREADY' // 409 这个成员档案已被别的账号认领
  | 'RATE_LIMITED' // 429 尝试次数过多，已锁定
  | 'FORBIDDEN'; // 403 其它越权

export interface ApiErrorBody {
  error: string;
  code?: ErrorCode;
}

/** 构造错误响应体。集中一处，避免各处手写字段名写岔。 */
export function errorBody(code: ErrorCode, message: string): ApiErrorBody {
  return { error: message, code };
}
