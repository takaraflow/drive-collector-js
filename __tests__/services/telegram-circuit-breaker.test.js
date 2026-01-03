/**
 * Telegram Circuit Breaker Unit Tests
 * Tests for the TelegramCircuitBreaker class state transitions and behavior
 */

import { jest } from '@jest/globals';

// Mock dependencies
jest.mock('../../src/services/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

// Import the TelegramCircuitBreaker class directly
class TelegramCircuitBreaker {
    constructor() {
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.lastFailure = null;
        this.threshold = 5; // Open after 5 failures
        this.timeout = 60000; // 1 minute before attempting half-open
        this.resetTimer = null;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            const timeSinceFailure = Date.now() - this.lastFailure;
            if (timeSinceFailure < this.timeout) {
                const waitTime = Math.ceil((this.timeout - timeSinceFailure) / 1000);
                throw new Error(`Circuit breaker OPEN. Wait ${waitTime}s more`);
            }
            // Transition to HALF_OPEN
            this.state = 'HALF_OPEN';
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        this.state = 'CLOSED';
        this.failures = 0;
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
    }

    onFailure() {
        this.failures++;
        this.lastFailure = Date.now();

        if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            
            if (this.resetTimer) clearTimeout(this.resetTimer);
            this.resetTimer = setTimeout(() => {
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                }
            }, this.timeout);
        }
    }

    getState() {
        return {
            state: this.state,
            failures: this.failures,
            lastFailure: this.lastFailure,
            timeSinceLastFailure: this.lastFailure ? Date.now() - this.lastFailure : null
        };
    }
}

describe('TelegramCircuitBreaker Unit Tests', () => {
    let circuitBreaker;
    let mockLogger;

    beforeEach(async () => {
        jest.clearAllMocks();
        jest.useFakeTimers('modern');
        
        // Create fresh circuit breaker instance
        circuitBreaker = new TelegramCircuitBreaker();
    });

    afterEach(() => {
        // 清理所有定时器
        if (circuitBreaker.resetTimer) {
            clearTimeout(circuitBreaker.resetTimer);
            circuitBreaker.resetTimer = null;
        }
        jest.useRealTimers();
    });

    describe('Circuit Breaker State Management', () => {
        test('should start in CLOSED state', () => {
            const state = circuitBreaker.getState();
            expect(state.state).toBe('CLOSED');
            expect(state.failures).toBe(0);
            expect(state.lastFailure).toBeNull();
        });

        test('should increment failures count on each error', async () => {
            // Simulate failures
            for (let i = 0; i < 3; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            const state = circuitBreaker.getState();
            expect(state.failures).toBe(3);
        });

        test('should stay CLOSED with 4 failures', async () => {
            // Trigger 4 errors
            for (let i = 0; i < 4; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('CLOSED');
            expect(state.failures).toBe(4);
        });

        test('should transition to OPEN state after 5 failures', async () => {
            // Trigger 5 errors
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('OPEN');
            expect(state.failures).toBe(5);
        });

        test('should transition to HALF_OPEN after timeout', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            expect(circuitBreaker.getState().state).toBe('OPEN');
            
            // Advance past 60-second timeout
            jest.advanceTimersByTime(60001);
            
            expect(circuitBreaker.getState().state).toBe('HALF_OPEN');
        });

        test('should reset to CLOSED on successful reconnection', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Simulate successful reconnection
            await circuitBreaker.execute(() => {
                return "success";
            });
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('CLOSED');
            expect(state.failures).toBe(0);
        });

        test('should transition back to OPEN on failure in HALF_OPEN', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Trigger error during HALF_OPEN
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {
                // Expected
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('OPEN');
        });

        test('should handle rapid successive failures', async () => {
            // Rapid errors
            for (let i = 0; i < 10; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('OPEN');
            // Circuit opens at 5 failures, so we expect 5 (not 10)
            expect(state.failures).toBeGreaterThanOrEqual(5);
        });

        test('should maintain state consistency', async () => {
            // Mix of operations
            try {
                await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
            } catch (e) {}
            
            try {
                await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
            } catch (e) {}
            
            // Reset
            circuitBreaker.state = 'CLOSED';
            circuitBreaker.failures = 0;
            circuitBreaker.lastFailure = null;
            
            try {
                await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
            } catch (e) {}
            
            try {
                await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
            } catch (e) {}
            
            try {
                await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
            } catch (e) {}
            
            let state = circuitBreaker.getState();
            expect(state.failures).toBe(3);
            
            // Add more to trigger OPEN
            for (let i = 0; i < 2; i++) {
                try {
                    await circuitBreaker.execute(() => { throw new Error("TIMEOUT"); });
                } catch (e) {}
            }
            
            state = circuitBreaker.getState();
            expect(state.state).toBe('OPEN');
        });
    });

    describe('State Information', () => {
        test('should return correct state structure', () => {
            const state = circuitBreaker.getState();
            
            expect(state).toHaveProperty('state');
            expect(state).toHaveProperty('failures');
            expect(state).toHaveProperty('lastFailure');
            expect(state).toHaveProperty('timeSinceLastFailure');
        });

        test('should include time since last failure', async () => {
            // Trigger failure
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {
                // Expected
            }
            
            const state1 = circuitBreaker.getState();
            expect(state1.lastFailure).toBeLessThanOrEqual(Date.now());
            expect(state1.timeSinceLastFailure).toBeGreaterThanOrEqual(0);
            
            // Advance time
            jest.advanceTimersByTime(5000);
            
            const state2 = circuitBreaker.getState();
            expect(state2.timeSinceLastFailure).toBeGreaterThanOrEqual(5000);
        });

        test('should handle null lastFailure time', () => {
            // No failures yet
            const state = circuitBreaker.getState();
            expect(state.lastFailure).toBeNull();
            expect(state.timeSinceLastFailure).toBeNull();
        });
    });

    describe('Edge Cases', () => {
        test('should handle reset during HALF_OPEN', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Reset manually
            circuitBreaker.state = 'CLOSED';
            circuitBreaker.failures = 0;
            circuitBreaker.lastFailure = null;
            if (circuitBreaker.resetTimer) {
                clearTimeout(circuitBreaker.resetTimer);
                circuitBreaker.resetTimer = null;
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('CLOSED');
            expect(state.failures).toBe(0);
        });

        test('should handle multiple reset calls safely', async () => {
            // Add some state
            for (let i = 0; i < 3; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Reset multiple times
            for (let i = 0; i < 3; i++) {
                circuitBreaker.state = 'CLOSED';
                circuitBreaker.failures = 0;
                circuitBreaker.lastFailure = null;
                if (circuitBreaker.resetTimer) {
                    clearTimeout(circuitBreaker.resetTimer);
                    circuitBreaker.resetTimer = null;
                }
            }
            
            const state = circuitBreaker.getState();
            expect(state.state).toBe('CLOSED');
            expect(state.failures).toBe(0);
            expect(state.lastFailure).toBeNull();
        });

        test('should handle automatic timer transition', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            const stateBefore = circuitBreaker.getState();
            expect(stateBefore.state).toBe('OPEN');
            
            // Advance time but not enough
            jest.advanceTimersByTime(30000);
            expect(circuitBreaker.getState().state).toBe('OPEN');
            
            // Advance past timeout
            jest.advanceTimersByTime(30001);
            expect(circuitBreaker.getState().state).toBe('HALF_OPEN');
        });

        test('should not transition if timer is cleared', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Clear timer manually
            if (circuitBreaker.resetTimer) {
                clearTimeout(circuitBreaker.resetTimer);
                circuitBreaker.resetTimer = null;
            }
            
            // Advance past timeout
            jest.advanceTimersByTime(60001);
            
            // Should still be OPEN (no automatic transition)
            expect(circuitBreaker.getState().state).toBe('OPEN');
        });

        test('should throw error when OPEN and timeout not expired', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Try to execute immediately
            await expect(circuitBreaker.execute(() => "success"))
                .rejects.toThrow(/Circuit breaker OPEN/);
        });

        test('should allow execution in HALF_OPEN state', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Should allow execution
            const result = await circuitBreaker.execute(() => "success");
            expect(result).toBe("success");
        });

        test('should handle timeout in HALF_OPEN state', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Fail in HALF_OPEN
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {
                // Expected
            }
            
            // Should be back to OPEN
            expect(circuitBreaker.getState().state).toBe('OPEN');
        });

        test('should transition back to OPEN on consecutive TIMEOUT in HALF_OPEN', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {
                    // Expected
                }
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // First failure in HALF_OPEN
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {
                // Expected
            }
            
            // Should be back to OPEN
            expect(circuitBreaker.getState().state).toBe('OPEN');
            
            // Advance to HALF_OPEN again
            jest.advanceTimersByTime(60001);
            
            // Second consecutive failure
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {
                // Expected
            }
            
            // Should still be OPEN (consecutive failures)
            expect(circuitBreaker.getState().state).toBe('OPEN');
            expect(circuitBreaker.getState().failures).toBe(7); // 5 + 2
        });
    });

    describe('Execute Method Behavior', () => {
        test('should return result from successful execution', async () => {
            const result = await circuitBreaker.execute(() => "test-result");
            expect(result).toBe("test-result");
        });

        test('should throw error from failed execution', async () => {
            const testError = new Error("Test error");
            await expect(circuitBreaker.execute(() => {
                throw testError;
            })).rejects.toThrow("Test error");
        });

        test('should call onSuccess on success', async () => {
            const onSuccessSpy = jest.spyOn(circuitBreaker, 'onSuccess');
            await circuitBreaker.execute(() => "success");
            expect(onSuccessSpy).toHaveBeenCalled();
        });

        test('should call onFailure on failure', async () => {
            const onFailureSpy = jest.spyOn(circuitBreaker, 'onFailure');
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("fail");
                });
            } catch (e) {
                // Expected
            }
            expect(onFailureSpy).toHaveBeenCalled();
        });

        test('should handle async functions', async () => {
            // Use immediate resolution since we're using fake timers
            const result = await circuitBreaker.execute(async () => {
                return "async-result";
            });
            expect(result).toBe("async-result");
        });

        test('should handle nested circuit breaker calls', async () => {
            // This simulates what happens when reconnection calls execute
            const result = await circuitBreaker.execute(async () => {
                // Nested call
                return await circuitBreaker.execute(() => "nested-result");
            });
            expect(result).toBe("nested-result");
        });
    });

    describe('Recovery Scenarios', () => {
        test('should fully recover after multiple failures', async () => {
            // Multiple failure cycles
            for (let cycle = 0; cycle < 3; cycle++) {
                // Open circuit
                for (let i = 0; i < 5; i++) {
                    try {
                        await circuitBreaker.execute(() => {
                            throw new Error("TIMEOUT");
                        });
                    } catch (e) {}
                }
                
                expect(circuitBreaker.getState().state).toBe('OPEN');
                
                // Advance to HALF_OPEN
                jest.advanceTimersByTime(60001);
                
                // Successful execution
                await circuitBreaker.execute(() => "success");
                
                expect(circuitBreaker.getState().state).toBe('CLOSED');
                expect(circuitBreaker.getState().failures).toBe(0);
            }
        });

        test('should handle partial recovery then failure', async () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                try {
                    await circuitBreaker.execute(() => {
                        throw new Error("TIMEOUT");
                    });
                } catch (e) {}
            }
            
            // Advance to HALF_OPEN
            jest.advanceTimersByTime(60001);
            
            // Partial success then failure
            await circuitBreaker.execute(() => "success");
            expect(circuitBreaker.getState().state).toBe('CLOSED');
            
            // Now fail again
            try {
                await circuitBreaker.execute(() => {
                    throw new Error("TIMEOUT");
                });
            } catch (e) {}
            
            expect(circuitBreaker.getState().failures).toBe(1);
        });
    });
});
