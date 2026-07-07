import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/. The Actions workflow
  // sets GITHUB_PAGES so the build emits that base; local dev stays at root.
  base: process.env.GITHUB_PAGES ? '/ramayana-rts/' : '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
});
