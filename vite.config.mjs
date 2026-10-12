import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        cup: fileURLToPath(new URL('./index.html', import.meta.url)),
        free: fileURLToPath(new URL('./free/index.html', import.meta.url)),
      },
    },
  },
});
