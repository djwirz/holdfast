import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The page calls the API on its own origin under /api; in development and in the E2E run
// that's proxied to the two-instance server on :3000. SSE streams through unbuffered.
const API = process.env['HOLDFAST_API'] ?? 'http://localhost:3000';
const proxy = { '/api': { target: API, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
