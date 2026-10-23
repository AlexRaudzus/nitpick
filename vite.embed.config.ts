// Library build of the in-app variant: `pnpm build:embed` → dist/embed/{index,loader}.js
// React stays external (peer dependency of the host app); everything else is bundled.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  build: {
    outDir: 'dist/embed',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: { index: 'embed/index.ts', loader: 'embed/loader.ts' },
      formats: ['es'],
    },
    rolldownOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
  },
});
