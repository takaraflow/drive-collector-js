// Time provider abstraction for deterministic testing
class TimeProvider {
    constructor() {
        this.currentTime = 1700000000000; // Fixed timestamp for tests
    }

    getTime() {
        return this.currentTime;
    }

    setTime(timestamp) {
        this.currentTime = timestamp;
    }

    advanceTime(ms) {
        this.currentTime += ms;
    }

    // Timer methods
    setTimeout(callback, delay) {
        // In tests, this would be handled by Jest fake timers
        return setTimeout(callback, delay);
    }

    clearTimeout(timeoutId) {
        clearTimeout(timeoutId);
    }

    setInterval(callback, interval) {
        return setInterval(callback, interval);
    }

    clearInterval(intervalId) {
        clearInterval(intervalId);
    }

    // Date helpers
    now() {
        return this.getTime();
    }

    nowAsDate() {
        return new Date(this.getTime());
    }

    formatTimestamp() {
        return new Date(this.getTime()).toISOString();
    }
}

// Singleton instance
const timeProvider = new TimeProvider();

export default timeProvider;
export { TimeProvider };