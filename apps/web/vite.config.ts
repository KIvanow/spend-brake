import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard calls the admin API on the same origin; in dev, Vite forwards it.
    proxy: { '/v1': process.env.BRAKE_API_URL ?? 'http://localhost:8081' },
  },
  // UI tests type and click through pages; a busy CI runner needs more than the 5 s default.
  test: { environment: 'jsdom', testTimeout: 30_000 },
});
