/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Dummy browser-safe values so the InsForge client constructs in tests
    // without real credentials. No network is made in unit/component tests.
    env: {
      VITE_INSFORGE_URL: 'https://test.local.insforge.app',
      VITE_INSFORGE_ANON_KEY: 'test-anon-key',
    },
  },
});
