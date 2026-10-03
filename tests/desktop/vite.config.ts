import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), publicDir: '../../public', envDir: false, plugins: [vue()],
  resolve: { alias: [{ find: /^ali-oss$/, replacement: fileURLToPath(new URL('./sdk.ts', import.meta.url)) }] },
  build: { outDir: '../../test-results/desktop-assets', emptyOutDir: true, target: 'chrome105' },
})
