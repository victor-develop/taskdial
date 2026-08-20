import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 存档在 localStorage，按 origin 分桶。端口一变就等于换了个桶、数据「消失」。
    // strictPort 让端口被占时直接报错退出，而不是静默顺延。
    port: 5183,
    strictPort: true,
  },
})
