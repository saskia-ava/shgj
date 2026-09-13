import { Hono } from 'hono';
import { csrfGuard, requireAuth } from './guards';
import authRoutes from './routes/auth';
import memberRoutes from './routes/members';
import expenseRoutes from './routes/expenses';
import balanceRoutes from './routes/balance';
import choreRoutes from './routes/chores';
import announcementRoutes from './routes/announcements';
import itemRoutes from './routes/items';
import type { AppEnv } from './env';

const app = new Hono<AppEnv>();

/** 健康检查。部署后第一时间用它确认服务在线。 */
app.get('/api/health', (c) => c.json({ ok: true, service: 'hezu-life-manager', time: Date.now() }));

// CSRF 校验对所有写操作生效，包括未登录就能调用的 /api/auth/*
app.use('/api/*', csrfGuard);

// 认证路由自己决定哪些端点要登录态（用 requireSession），
// 因为它们要处理「已登录但还没选房间」这个中间态——那种状态下 requireAuth
// 会直接 403，而用户恰恰需要在这批接口里把房间选出来。
app.route('/api/auth', authRoutes);

// 从这里往下都要求「会话有效 + 当前房间下有在住身份」。Hono 的中间件只作用于
// 「注册在其后」的路由，因此上面那批 /api/auth/* 不受影响。
//
// requireAuth 注入的 memberId / householdId / memberName 三个上下文变量，
// 键名和语义与重构前完全一致，所以下面 6 个业务路由文件一行都不用改。
app.use('/api/*', requireAuth);

app.route('/api/members', memberRoutes);
app.route('/api/expenses', expenseRoutes);
app.route('/api/balance', balanceRoutes);
app.route('/api/chores', choreRoutes);
app.route('/api/announcements', announcementRoutes);
app.route('/api/items', itemRoutes);

app.notFound((c) => {
  // 非 /api/* 的请求由静态资源绑定处理（wrangler.jsonc 里的 run_worker_first 只放行 /api/*）。
  // 走到这里说明是没匹配上的 API 路径。
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: '接口不存在' }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);

  // 表不存在通常是忘了建库。给出可操作的指引，而不是一个光秃秃的 500。
  if (/no such table/i.test(message)) {
    return c.json(
      {
        error: '数据库尚未初始化，请先执行迁移',
        hint: '本地：npm run db:local　　线上：npm run db:remote',
      },
      500,
    );
  }

  // 余额对不平说明分摊数据已损坏。这是需要人工介入的严重问题，
  // 明确记到日志里，不要伪装成普通的接口错误。
  if (/对不平|不在本房间/.test(message)) {
    console.error('[数据完整性]', message);
    return c.json({ error: '账目数据异常，请联系维护者' }, 500);
  }

  console.error('[未处理错误]', err);
  return c.json({ error: '服务器内部错误' }, 500);
});

export default app;
