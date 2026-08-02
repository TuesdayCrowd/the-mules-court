// @ts-nocheck
/**
 * GENERATED — do not edit. Run `bun run compile` to regenerate.
 *
 * One `type: 'file'` import per file in dist/, plus the URL-path map
 * `embeddedLookup` reads. Each import evaluates to a *path* string: an absolute
 * filesystem path under `bun`, an opaque embedded-VFS path inside a compiled
 * binary. `Bun.file` accepts both, which is why `standalone.ts` runs and tests
 * without a 71 MB build step.
 *
 * Type-checking is off because three of dist/'s extensions have no usable
 * declaration for a file import — @types/bun types *.html as HTMLBundle, *.js
 * resolves to the real module, *.md has none at all. That also makes the
 * references below harmless on a clone whose dist/ has never been built, which
 * is what lets this file be committed. The annotated export keeps every call
 * site fully checked.
 */
import a0 from '../../dist/assets/PORTRAIT_PROMPTS.md' with { type: 'file' };
import a1 from '../../dist/assets/bail-channis/portrait_0.png' with { type: 'file' };
import a2 from '../../dist/assets/bayta-darell/portrait_0.png' with { type: 'file' };
import a3 from '../../dist/assets/card-back/card_back_2.png' with { type: 'file' };
import a4 from '../../dist/assets/ebling-mis/portrait_0.png' with { type: 'file' };
import a5 from '../../dist/assets/first-speaker/portrait_0.png' with { type: 'file' };
import a6 from '../../dist/assets/han-pritcher/portrait_0.png' with { type: 'file' };
import a7 from '../../dist/assets/index-BQNYThF2.css' with { type: 'file' };
import a8 from '../../dist/assets/index-BS5YBFBR.js' with { type: 'file' };
import a9 from '../../dist/assets/informant/portrait_0.png' with { type: 'file' };
import a10 from '../../dist/assets/magnifico/portrait_0.png' with { type: 'file' };
import a11 from '../../dist/assets/mayor-indbur/portrait_0.png' with { type: 'file' };
import a12 from '../../dist/assets/misc/devotion_token.png' with { type: 'file' };
import a13 from '../../dist/assets/misc/playfield_background_space.png' with { type: 'file' };
import a14 from '../../dist/assets/mule/portrait_0.png' with { type: 'file' };
import a15 from '../../dist/assets/shaders/distortion_map.png' with { type: 'file' };
import a16 from '../../dist/assets/shaders/rainbow_gradient.png' with { type: 'file' };
import a17 from '../../dist/assets/shaders/sparkle_pattern.png' with { type: 'file' };
import a18 from '../../dist/assets/shielded-mind/portrait_0.png' with { type: 'file' };
import a19 from '../../dist/assets/toran-darell/portrait_0.png' with { type: 'file' };
import a20 from '../../dist/favicon.png' with { type: 'file' };
import a21 from '../../dist/fonts/exo2-600.woff2' with { type: 'file' };
import a22 from '../../dist/fonts/inter-var-latin-ext.woff2' with { type: 'file' };
import a23 from '../../dist/fonts/inter-var-latin.woff2' with { type: 'file' };
import a24 from '../../dist/index.html' with { type: 'file' };
import a25 from '../../dist/love-letter-rules.md' with { type: 'file' };
import a26 from '../../dist/salvor-hardin-quotes.txt' with { type: 'file' };

export const EMBEDDED: ReadonlyMap<string, string> = new Map([
    ['/assets/PORTRAIT_PROMPTS.md', a0],
    ['/assets/bail-channis/portrait_0.png', a1],
    ['/assets/bayta-darell/portrait_0.png', a2],
    ['/assets/card-back/card_back_2.png', a3],
    ['/assets/ebling-mis/portrait_0.png', a4],
    ['/assets/first-speaker/portrait_0.png', a5],
    ['/assets/han-pritcher/portrait_0.png', a6],
    ['/assets/index-BQNYThF2.css', a7],
    ['/assets/index-BS5YBFBR.js', a8],
    ['/assets/informant/portrait_0.png', a9],
    ['/assets/magnifico/portrait_0.png', a10],
    ['/assets/mayor-indbur/portrait_0.png', a11],
    ['/assets/misc/devotion_token.png', a12],
    ['/assets/misc/playfield_background_space.png', a13],
    ['/assets/mule/portrait_0.png', a14],
    ['/assets/shaders/distortion_map.png', a15],
    ['/assets/shaders/rainbow_gradient.png', a16],
    ['/assets/shaders/sparkle_pattern.png', a17],
    ['/assets/shielded-mind/portrait_0.png', a18],
    ['/assets/toran-darell/portrait_0.png', a19],
    ['/favicon.png', a20],
    ['/fonts/exo2-600.woff2', a21],
    ['/fonts/inter-var-latin-ext.woff2', a22],
    ['/fonts/inter-var-latin.woff2', a23],
    ['/index.html', a24],
    ['/love-letter-rules.md', a25],
    ['/salvor-hardin-quotes.txt', a26]
]);
