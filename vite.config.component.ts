import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/path-tracer.ts'),
      formats: ['iife'],
      name: 'PathTracer',
      fileName: () => 'path-tracer.js',
    },
    outDir: 'dist-component',
    emptyOutDir: true,
    minify: 'esbuild',
  },
});
