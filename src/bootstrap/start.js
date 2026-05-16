/**
 * Runtime entrypoint.
 *
 * Keep telemetry bootstrap here so every deployment path runs the same startup
 * sequence: hydrate early runtime env, start OTel if configured, then load app.
 */
import path from 'path';
import { fileURLToPath } from 'url';

await import('../telemetry/tracing.js');

export async function start() {
    const { main } = await import('../../index.js');
    return main();
}

const modulePath = fileURLToPath(import.meta.url);
const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isDirectRun = entryPoint === modulePath;

if (isDirectRun) {
    await start();
}
