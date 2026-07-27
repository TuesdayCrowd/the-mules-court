/**
 * Decides what a compiled binary embeds, and writes the source that embeds it.
 *
 * Bun resolves `with { type: 'file' }` at bundle time, so the import list cannot
 * be a runtime glob over `dist/` — it has to be code. Code that is generated is
 * code worth testing, so both functions here are pure enough to drive from a
 * fixture tree, and `scripts/generateEmbeddedAssets.ts` adds only the read of
 * the real directory and the write.
 *
 * The module this renders is committed, not gitignored: `standalone.ts` imports
 * it, so a clone without it fails `bunx tsc --noEmit` — the only type check this
 * project has.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Where the generated module sits relative to `dist/`, as an import prefix. */
const IMPORT_PREFIX = '../../dist';

/** The app shell; a manifest without one has nothing for a client route. */
const SHELL = '/index.html';

/**
 * Every file under `root`, as sorted URL paths ('/assets/app.js').
 *
 * Dotfiles are skipped at every depth. `public/` is copied into `dist/`
 * verbatim, and macOS has already put a `.DS_Store` in there once — a generator
 * without this filter bakes it into the binary.
 *
 * Sorted so an unchanged `dist/` regenerates a byte-identical manifest: the
 * file is committed, and output that depended on directory-read order would
 * show a diff on every build.
 *
 * Everything else in `dist/` is embedded, including the markdown and text files
 * Vite copies from `public/`. Dropping them would be a silent cap on what the
 * binary serves, and `dist/` is the deliverable — if a file should not ship, it
 * should not be in `public/`.
 */
export function collectAssetFiles(root: string): string[] {
    if (!existsSync(root)) {
        throw new Error(`Asset root not found: ${root} — run \`bun run build\` first.`);
    }

    const files: string[] = [];

    const walk = (dir: string, urlPrefix: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry.startsWith('.')) continue;

            const full = join(dir, entry);
            const url = posix.join(urlPrefix, entry);
            if (statSync(full).isDirectory()) walk(full, url);
            else files.push(url);
        }
    };

    walk(root, '/');
    files.sort();

    if (!files.includes(SHELL)) {
        // An empty or shell-less manifest compiles fine and 404s everything: a
        // binary that starts, serves nothing, and explains nothing.
        throw new Error(`Asset root ${root} has no ${SHELL} — the SPA fallback would have nothing to serve.`);
    }

    return files;
}

/** Renders the generated module's source text for `files`. */
export function renderManifest(files: string[]): string {
    const imports = files
        .map((file, i) => `import a${i} from '${IMPORT_PREFIX}${file}' with { type: 'file' };`)
        .join('\n');

    const entries = files.length === 0 ? '' : `\n${files.map((file, i) => `    ['${file}', a${i}]`).join(',\n')}\n`;

    return `// @ts-nocheck
/**
 * GENERATED — do not edit. Run \`bun run compile\` to regenerate.
 *
 * One \`type: 'file'\` import per file in dist/, plus the URL-path map
 * \`embeddedLookup\` reads. Each import evaluates to a *path* string: an absolute
 * filesystem path under \`bun\`, an opaque embedded-VFS path inside a compiled
 * binary. \`Bun.file\` accepts both, which is why \`standalone.ts\` runs and tests
 * without a 71 MB build step.
 *
 * Type-checking is off because three of dist/'s extensions have no usable
 * declaration for a file import — @types/bun types *.html as HTMLBundle, *.js
 * resolves to the real module, *.md has none at all. That also makes the
 * references below harmless on a clone whose dist/ has never been built, which
 * is what lets this file be committed. The annotated export keeps every call
 * site fully checked.
 */
${imports}

export const EMBEDDED: ReadonlyMap<string, string> = new Map([${entries}]);
`;
}
