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

// Unit tests (test/*.test.ts) cover modules that do not import `vscode`; each one is bundled
// to out/test/ and run with Node's built-in test runner (`npm test`).
const testOptions = {
  entryPoints: ['test/*.test.ts'],
  bundle: true,
  outdir: 'out/test',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: 'inline',
  minify: false,
};

if (process.argv.includes('--tests')) {
  esbuild.build(testOptions).catch(() => process.exit(1));
} else if (process.argv.includes('--watch')) {
  esbuild.context(options).then(ctx => {
    console.log('[esbuild] watching src/ …');
    return ctx.watch();
  }).catch(() => process.exit(1));
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
