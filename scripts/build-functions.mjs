// Bundle each edge function entry into a single deployable file. The InsForge
// CLI deploys one file per function, so we bundle server/lib + _shared into the
// entry and leave `npm:` / `node:` specifiers external for the Deno runtime to
// resolve. Run: `node scripts/build-functions.mjs`.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

const FUNCTIONS = ['job-worker-tick', 'console-actions', 'github-webhook', 'datadog-webhook'];
const OUT_DIR = 'server/dist';

mkdirSync(OUT_DIR, { recursive: true });

for (const slug of FUNCTIONS) {
  await build({
    entryPoints: [`server/functions/${slug}/index.ts`],
    outfile: `${OUT_DIR}/${slug}.js`,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'esnext',
    // Deno resolves these; everything else (server/lib, _shared) is bundled in.
    external: ['npm:*', 'node:*'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log(`✓ bundled ${slug} → ${OUT_DIR}/${slug}.js`);
}
