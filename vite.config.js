import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/chat': 'http://127.0.0.1:8000',
      '/model': 'http://127.0.0.1:8000',
      '/models': 'http://127.0.0.1:8000',
      '/download': 'http://127.0.0.1:8000',
      '/download/status': 'http://127.0.0.1:8000',
      '/restart': 'http://127.0.0.1:8000'
    }
  }
})
