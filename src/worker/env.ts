import type { SessionRecord } from './auth';

export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** 静态资源绑定（SPA 构建产物） */
  ASSETS: Fetcher;
  /**
   * 哈希用的 pepper：一个高熵密钥，存在 Worker secret 里，**绝不入库**。
   *
   * 它让「数据库泄露」不再等于「密码可被离线爆破」——攻击者拿到整个库也
   * 缺这一半输入。正因为它在承担主要的抗爆破职责，PBKDF2 的轮数才可以
   * 压到 6,000 以适配 Workers 免费版的 10ms CPU 上限（见 auth.ts 顶部）。
   *
   * ⚠️ 这个值一旦丢失，**所有人都无法登录，且没有任何运维手段可以重置**——
   *    它不参与任何可逆运算，没有它就无法校验任何哈希。线上值是通过
   *    `wrangler secret put` 写入的，本地副本在 .dev.vars（已 gitignore），
   *    另有一份灾备副本 .pin-pepper.backup.txt（同样 gitignore）。
   *
   * 设置：npx wrangler secret put PIN_PEPPER
   */
  PIN_PEPPER: string;
}

/**
 * 认证中间件注入到请求上下文里的登录态。
 *
 * ⚠️ `memberId` / `householdId` / `memberName` 这三个键名和语义**必须保持
 *    不变**：业务路由（routes/ 下的 6 个文件）里 30 多处 c.get('householdId')
 *    全靠它们。这套账号体系重构刻意让中间件内部换实现、对外零改动，
 *    就是为了不动那些已经正确工作的业务代码。
 *
 * `accountId` 在 requireSession 之后就有；
 * 另外三个只在 requireAuth 之后才保证存在（requireAuth 会先确认当前房间下
 * 确实有一条在住成员档案，否则直接 403）。
 */
export interface Variables {
  accountId: string;
  memberId: string;
  householdId: string;
  memberName: string;
  /** 完整登录态。requireSession / requireAuth 之后都有。 */
  session: SessionRecord;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
