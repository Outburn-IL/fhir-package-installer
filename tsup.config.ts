import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/mock-artifactory-server.ts'],
  dts: true,
  format: ['cjs', 'esm'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  target: 'node18',
  minify: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  noExternal: ['p-limit', 'yocto-queue'],
  splitting: false,
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    return { js: '.cjs' };
  }
});
