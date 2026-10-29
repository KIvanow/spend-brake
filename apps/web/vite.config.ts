import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard calls the admin API on the same origin; in dev, Vite forwards it.
    proxy: { '/v1': process.env.BRAKE_API_URL ?? 'http://localhost:8081' },
  },
  test: { environment: 'jsdom' },
});
