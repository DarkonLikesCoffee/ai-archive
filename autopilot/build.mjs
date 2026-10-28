// Bundles the TypeScript entry points and copies static files into dist/.
// Load dist/ as an unpacked extension in chrome://extensions.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const outdir = `${root}dist`;
const watch = process.argv.includes('--watch');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(`${root}static`, outdir, { recursive: true });

const options = {
  entryPoints: {
    background: `${root}src/background/index.ts`,
    content: `${root}src/content/index.ts`,
    ui: `${root}src/ui/app.ts`,
  },
  outdir,
  bundle: true,
  // Content scripts cannot be ES modules; IIFE works for every context.
  format: 'iife',
  target: 'chrome116',
  loader: { '.md': 'text' },
  sourcemap: 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
