import esbuild from 'esbuild';

const production = process.argv[2] === 'production';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  sourcemap: production ? false : 'inline',
  outfile: 'main.js',
  logLevel: 'info'
});
if (production) { await context.rebuild(); await context.dispose(); }
else { await context.watch(); }
