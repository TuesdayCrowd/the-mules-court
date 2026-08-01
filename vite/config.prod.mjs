import { defineConfig } from 'vite';

/**
 * A build banner, and nothing more.
 *
 * This replaces the `phasermsg` plugin the Phaser starter template shipped,
 * which printed an invitation to email games@phaser.io. The engine is gone
 * (`docs/plans/2026-07-30-renderer-architecture-research.md`), so an
 * advertisement for it on every production build is no longer honest.
 */
const buildBanner = () => {
    return {
        name: 'build-banner',
        buildStart() {
            process.stdout.write(`Building for production...\n`);
        },
        buildEnd() {
            process.stdout.write(`✨ Done ✨\n`);
        }
    };
};

export default defineConfig({
    // Absolute, not './': the client owns the /join/:matchId route (UIX §2.6),
    // and a relative base resolves asset URLs against /join/ on a real invite
    // link, so the app never boots. The relative base existed so dist/ could be
    // hosted from a subpath; those routes trade that away deliberately.
    base: '/',
    logLevel: 'warning',
    build: {
        minify: 'terser',
        terserOptions: {
            compress: {
                passes: 2
            },
            mangle: true,
            format: {
                comments: false
            }
        }
    },
    server: {
        port: 8080
    },
    plugins: [
        buildBanner()
    ]
});
