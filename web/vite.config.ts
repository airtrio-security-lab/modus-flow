import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` proxies the API to the platform server on :3100.
// Demo/production: `npm run build` → web/dist, served by platform/main.ts (same origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3100' } },
  build: { target: 'es2020', sourcemap: false },
});
