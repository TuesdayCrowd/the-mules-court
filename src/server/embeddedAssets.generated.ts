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
import a0 from '../../dist/assets/bail-channis/portrait_0.png' with { type: 'file' };
import a1 from '../../dist/assets/bayta-darell/portrait_0.png' with { type: 'file' };
import a2 from '../../dist/assets/card-back/card_back_2.png' with { type: 'file' };
import a3 from '../../dist/assets/ebling-mis/portrait_0.png' with { type: 'file' };
import a4 from '../../dist/assets/first-speaker/portrait_0.png' with { type: 'file' };
import a5 from '../../dist/assets/han-pritcher/portrait_0.png' with { type: 'file' };
import a6 from '../../dist/assets/index-5wcmald1.css' with { type: 'file' };
import a7 from '../../dist/assets/index-BTl1GBjl.js' with { type: 'file' };
import a8 from '../../dist/assets/informant/portrait_0.png' with { type: 'file' };
import a9 from '../../dist/assets/magnifico/portrait_0.png' with { type: 'file' };
import a10 from '../../dist/assets/mayor-indbur/portrait_0.png' with { type: 'file' };
import a11 from '../../dist/assets/misc/devotion_token.png' with { type: 'file' };
import a12 from '../../dist/assets/misc/playfield_background_space.png' with { type: 'file' };
import a13 from '../../dist/assets/mule/portrait_0.png' with { type: 'file' };
import a14 from '../../dist/assets/sfx/amb-lobby.mp3' with { type: 'file' };
import a15 from '../../dist/assets/sfx/amb-mule-presence.mp3' with { type: 'file' };
import a16 from '../../dist/assets/sfx/amb-table.mp3' with { type: 'file' };
import a17 from '../../dist/assets/sfx/amb-vault.mp3' with { type: 'file' };
import a18 from '../../dist/assets/sfx/deal.mp3' with { type: 'file' };
import a19 from '../../dist/assets/sfx/elimination.mp3' with { type: 'file' };
import a20 from '../../dist/assets/sfx/mule.mp3' with { type: 'file' };
import a21 from '../../dist/assets/sfx/play.mp3' with { type: 'file' };
import a22 from '../../dist/assets/sfx/refused.mp3' with { type: 'file' };
import a23 from '../../dist/assets/sfx/reveal.mp3' with { type: 'file' };
import a24 from '../../dist/assets/sfx/token-award.mp3' with { type: 'file' };
import a25 from '../../dist/assets/sfx/victory.mp3' with { type: 'file' };
import a26 from '../../dist/assets/sfx/your-turn.mp3' with { type: 'file' };
import a27 from '../../dist/assets/shaders/distortion_map.png' with { type: 'file' };
import a28 from '../../dist/assets/shaders/rainbow_gradient.png' with { type: 'file' };
import a29 from '../../dist/assets/shaders/sparkle_pattern.png' with { type: 'file' };
import a30 from '../../dist/assets/shielded-mind/portrait_0.png' with { type: 'file' };
import a31 from '../../dist/assets/toran-darell/portrait_0.png' with { type: 'file' };
import a32 from '../../dist/favicon.png' with { type: 'file' };
import a33 from '../../dist/fonts/exo2-600.woff2' with { type: 'file' };
import a34 from '../../dist/fonts/inter-var-latin-ext.woff2' with { type: 'file' };
import a35 from '../../dist/fonts/inter-var-latin.woff2' with { type: 'file' };
import a36 from '../../dist/index.html' with { type: 'file' };
import a37 from '../../dist/love-letter-rules.md' with { type: 'file' };
import a38 from '../../dist/salvor-hardin-quotes.txt' with { type: 'file' };

export const EMBEDDED: ReadonlyMap<string, string> = new Map([
    ['/assets/bail-channis/portrait_0.png', a0],
    ['/assets/bayta-darell/portrait_0.png', a1],
    ['/assets/card-back/card_back_2.png', a2],
    ['/assets/ebling-mis/portrait_0.png', a3],
    ['/assets/first-speaker/portrait_0.png', a4],
    ['/assets/han-pritcher/portrait_0.png', a5],
    ['/assets/index-5wcmald1.css', a6],
    ['/assets/index-BTl1GBjl.js', a7],
    ['/assets/informant/portrait_0.png', a8],
    ['/assets/magnifico/portrait_0.png', a9],
    ['/assets/mayor-indbur/portrait_0.png', a10],
    ['/assets/misc/devotion_token.png', a11],
    ['/assets/misc/playfield_background_space.png', a12],
    ['/assets/mule/portrait_0.png', a13],
    ['/assets/sfx/amb-lobby.mp3', a14],
    ['/assets/sfx/amb-mule-presence.mp3', a15],
    ['/assets/sfx/amb-table.mp3', a16],
    ['/assets/sfx/amb-vault.mp3', a17],
    ['/assets/sfx/deal.mp3', a18],
    ['/assets/sfx/elimination.mp3', a19],
    ['/assets/sfx/mule.mp3', a20],
    ['/assets/sfx/play.mp3', a21],
    ['/assets/sfx/refused.mp3', a22],
    ['/assets/sfx/reveal.mp3', a23],
    ['/assets/sfx/token-award.mp3', a24],
    ['/assets/sfx/victory.mp3', a25],
    ['/assets/sfx/your-turn.mp3', a26],
    ['/assets/shaders/distortion_map.png', a27],
    ['/assets/shaders/rainbow_gradient.png', a28],
    ['/assets/shaders/sparkle_pattern.png', a29],
    ['/assets/shielded-mind/portrait_0.png', a30],
    ['/assets/toran-darell/portrait_0.png', a31],
    ['/favicon.png', a32],
    ['/fonts/exo2-600.woff2', a33],
    ['/fonts/inter-var-latin-ext.woff2', a34],
    ['/fonts/inter-var-latin.woff2', a35],
    ['/index.html', a36],
    ['/love-letter-rules.md', a37],
    ['/salvor-hardin-quotes.txt', a38]
]);
