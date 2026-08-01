import { defineConfig } from 'vite';

export default defineConfig({
    // Absolute, not './': the client owns the /join/:matchId route (UIX §2.6),
    // and a relative base resolves asset URLs against /join/ on a real invite
    // link, so the app never boots. The relative base existed so dist/ could be
    // hosted from a subpath; those routes trade that away deliberately.
    base: '/',
    server: {
        port: 8080,
        // Same-origin in dev, so socketUrl() derives ws://localhost:8080/ws and
        // one code path serves dev and production alike — no env var, no CORS.
        proxy: {
            '/api': { target: 'http://localhost:3000', changeOrigin: true },
            '/ws': { target: 'ws://localhost:3000', ws: true }
        }
    }
});
