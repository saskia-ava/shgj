import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts：纯算法单测不需要加载 @cloudflare/vite-plugin，
// 也就不依赖 Worker 入口和 wrangler 配置，跑得更快也更稳。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
