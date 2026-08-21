// vitest/config 的 defineConfig 才认 test 字段（vite 那个不认）
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // .claude/worktrees 里是整份仓库的副本，不排掉的话同一批测试会被跑两遍，
    // 数字凭空翻倍，而且陈旧副本挂了会当成本仓库挂了
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
  server: {
    // 存档在 localStorage，按 origin 分桶。端口一变就等于换了个桶、数据「消失」。
    // strictPort 让端口被占时直接报错退出，而不是静默顺延。
    port: 5183,
    strictPort: true,
  },
})
