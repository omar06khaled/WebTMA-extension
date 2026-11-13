import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development Vite proxies /api and /auth to the C# API, so the browser sees one origin
// and the session cookie just works. The production build goes into the API's wwwroot.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5080',
      '/auth': 'http://localhost:5080',
    },
  },
  build: {
    outDir: '../api/DeskManual.Api/wwwroot',
    emptyOutDir: true,
  },
})
