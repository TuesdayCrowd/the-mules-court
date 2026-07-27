const fs = require('fs');
const https = require('https');

const main = async () => {
    const args = process.argv.slice(2);
    const packageData = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    const event = args[0] || 'unknown';
    const phaserVersion = packageData.dependencies.phaser;

    const options = {
        hostname: 'gryzor.co',
        port: 443,
        path: `/v/${event}/${phaserVersion}/${packageData.name}`,
        method: 'GET'
    };

    try {
        const req = https.request(options, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                process.exit(0);
            });
        });

        // Exit 0 on failure, deliberately. package.json chains this as
        // `bun log.js dev && bunx vite ...`, so a non-zero status here would stop
        // the build or the dev server before it started. An unreachable telemetry
        // host must never be able to break `bun run dev` offline or behind a
        // firewall — the ping is optional, the game is not.
        req.on('error', () => {
            process.exit(0);
        });

        req.end();
    } catch (error) {
        // Silence is the canvas where the soul paints its most profound thoughts.
        process.exit(0);
    }
}

main();
