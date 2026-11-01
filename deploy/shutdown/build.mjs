import { build } from 'vite';
import { fileURLToPath } from 'node:url';
await build({
  configFile: false,
  root: fileURLToPath(new URL('./site', import.meta.url)),
  base: '/', publicDir: fileURLToPath(new URL('./static/', import.meta.url)),
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
