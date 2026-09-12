import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// @cloudflare/vite-plugin 读取 wrangler.jsonc，把 Worker（含 D1 绑定）
// 和 Vite 的 HMR 跑在同一个 dev server 里，本地开发无需手工配 proxy。
export default defineConfig({
  plugins: [react(), cloudflare()],
});
