import { handleWebhook, setAppReadyState } from './src/webhook/WebhookRouter.js';

async function run() {
    setAppReadyState(true);
    let statusCode = 0;
    let endMessage = '';
    const req = {
        method: 'GET',
        url: '/health',
        headers: { host: 'localhost' }
    };
    const res = {
        writeHead: (code) => { statusCode = code; },
        end: (msg) => { endMessage = msg; }
    };

    // Simulate error by throwing in includes
    const originalUrl = req.url;
    Object.defineProperty(req, 'url', {
        get() { throw new Error('Simulated error for catch block'); }
    });

    await handleWebhook(req, res);
    console.log(`Status code: ${statusCode}`);
    console.log(`End message: ${endMessage}`);
}

run().catch(console.error);
