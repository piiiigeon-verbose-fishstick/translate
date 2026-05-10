import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'https://www.dmxapi.cn',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api/, '/v1'),
          onProxyReq: (proxyReq) => {
            proxyReq.setHeader('Authorization', `Bearer ${env.VITE_API_KEY}`)
          }
        }
      }
    }
  }
})
