import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import path from 'path';

// Two builds:
// - default: the npm package (ES + CJS). livekit-client stays external so apps
//   that also use LiveKit share one copy; npm installs it as our dependency.
// - `--mode umd`: the script-tag bundle (dist/rymi.js), self-contained with
//   livekit-client inlined. Runs second so it doesn't wipe the npm output.
export default defineConfig(({ mode }) => {
  const umd = mode === 'umd';
  return {
    build: {
      lib: {
        entry: path.resolve(__dirname, 'src/index.ts'),
        name: 'Rymi',
        formats: umd ? ['umd'] : ['es', 'cjs'],
        fileName: (format) => (format === 'umd' ? 'rymi.js' : format === 'cjs' ? 'rymi.cjs' : 'rymi.mjs'),
      },
      rollupOptions: {
        external: umd ? [] : [/^livekit-client(\/.*)?$/],
        output: {
          exports: 'named',
        },
      },
      sourcemap: true,
      emptyOutDir: !umd,
    },
    plugins: umd
      ? []
      : [dts({
          insertTypesEntry: true,
          entryRoot: path.resolve(__dirname, 'src'),
          exclude: ['**/*.test.ts'],
        })],
  };
});
