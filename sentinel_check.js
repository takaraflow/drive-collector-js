const fs = require('fs');

function checkFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let hasMathRandom = false;
    let hasCryptoImport = false;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('Math.random')) {
            console.log(`Found Math.random in ${filePath} at line ${i + 1}`);
            hasMathRandom = true;
        }
        if (lines[i].includes('import crypto') || lines[i].includes('import { crypto') || lines[i].includes('from "crypto"') || lines[i].includes("from 'crypto'")) {
            hasCryptoImport = true;
        }
    }

    if (hasMathRandom) {
        console.log(`  Crypto import status for ${filePath}: ${hasCryptoImport}`);
    }
}

const files = [
    'src/services/EnhancedGracefulShutdown.js',
    'src/services/CacheService.js',
    'src/services/BatchProcessor.js',
    'src/services/queue/CloudQueueBase.js',
    'src/services/queue/QstashQueue.js',
    'src/services/queue/LocalBufferQueue.js',
    'src/services/telegram.js',
    'src/services/logger/LoggerService.js',
    'src/services/logger/AxiomLogger.js',
    'src/services/SmartFailover.js',
    'src/services/StreamTransferService.js',
    'src/services/StateSynchronizer.js',
    'src/dispatcher/bootstrap.js',
    'src/utils/limiter.js'
];

files.forEach(checkFile);
