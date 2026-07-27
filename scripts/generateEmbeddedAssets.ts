/**
 * Regenerates `src/server/embeddedAssets.generated.ts` from `dist/`.
 *
 * Thin by design: every decision lives in `src/server/embeddedManifest.ts`,
 * which is tested against a fixture tree. This file adds a read of the real
 * directory and one write, and is meant to be reviewed by reading.
 *
 * Run through `bun run compile`, which builds dist/ first. Running it by hand
 * against a stale dist/ produces a manifest naming chunks that no longer exist,
 * and the compile step fails loudly on the missing import.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAssetFiles, renderManifest } from '../src/server/embeddedManifest';

const repoRoot = join(import.meta.dir, '..');
const distRoot = join(repoRoot, 'dist');
const outPath = join(repoRoot, 'src', 'server', 'embeddedAssets.generated.ts');

const files = collectAssetFiles(distRoot);
writeFileSync(outPath, renderManifest(files));

console.log(`Embedded ${files.length} files from dist/ → src/server/embeddedAssets.generated.ts`);
