const ORIGINAL_CONSOLE_SYMBOL = Symbol.for('driveCollector.logger.originalConsole');

const captureOriginalConsole = () => ({
    error: console.error,
    warn: console.warn,
    log: console.log,
    debug: console.debug || console.log
});

const originalConsole = globalThis[ORIGINAL_CONSOLE_SYMBOL] || captureOriginalConsole();
globalThis[ORIGINAL_CONSOLE_SYMBOL] = originalConsole;

export const getOriginalConsoleMethod = (level = 'log') => {
    return originalConsole[level] || originalConsole.log;
};

export const writeOriginalConsole = (level, ...args) => {
    const method = getOriginalConsoleMethod(level);
    method.call(console, ...args);
};

export const restoreOriginalConsole = () => {
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.log = originalConsole.log;
    if (console.debug && originalConsole.debug) {
        console.debug = originalConsole.debug;
    }
};
