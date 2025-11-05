import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: [
        resolve(__dirname, '..'),
        resolve(__dirname, '../.dfx'),
        resolve(__dirname, '..', '..')
      ]
    }
  },
  build: {
    outDir: 'dist'
  }
});
