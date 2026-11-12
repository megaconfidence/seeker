import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.SEEKER_BACKEND ?? 'http://localhost:7335'

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/mcp': backend,
    },
  },
})
