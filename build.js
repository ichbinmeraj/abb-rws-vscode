const esbuild = require('esbuild');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],   // vscode is provided by the host - never bundle it
  format: 'cjs',          // VS Code extension host requires CommonJS
  platform: 'node',
  sourcemap: true,
  minify: false,
};

if (process.argv.includes('--watch')) {
  esbuild.context(options).then(ctx => {
    console.log('[esbuild] watching src/ …');
    return ctx.watch();
  }).catch(() => process.exit(1));
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
