// Vite config for the React frontend.
// In development (npm run dev) Vite serves the frontend on port 5173 and
// proxies every backend path to the FastAPI server on port 8000, so the
// frontend can use relative URLs in both dev and production.
// https://vitejs.dev/config/

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BACKEND = 'http://127.0.0.1:8000'

// Keep this list in sync with the routes in server/routes/ (each entry covers
// the path and everything under it).
const BACKEND_PATHS = [
  '/chat',
  '/model',
  '/models',
  '/download',
  '/conversations',
  '/upload',
  '/uploads',
  '/api',
]

export default defineConfig({
  plugins: [react()],
  server: {
    open: true,
    proxy: Object.fromEntries(BACKEND_PATHS.map((path) => [
      path,
      {
        target: BACKEND,
        ws: true,
      }
    ])),
  },
})
