export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** 静态资源绑定（SPA 构建产物） */
  ASSETS: Fetcher;
  /**
   * PIN 哈希用的 pepper：一个高熵密钥，存在 Worker secret 里，**绝不入库**。
   *
   * 它让「数据库泄露」不再等于「密码可被离线爆破」——攻击者拿到整个库也
   * 缺这一半输入。正因为它在承担主要的抗爆破职责，PBKDF2 的轮数才可以
   * 降到 25,000 以适配 Workers 免费版的 10ms CPU 上限。
   *
   * 设置：npx wrangler secret put PIN_PEPPER
   * 本地开发：写在 .dev.vars 里（该文件已在 .gitignore 中）
   */
  PIN_PEPPER: string;
}

/** 认证中间件注入到请求上下文里的登录态。 */
export interface Variables {
  memberId: string;
  householdId: string;
  memberName: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
