import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { TelegramErrorClassifier } from "../../src/services/telegram-error-classifier.js";

describe("TelegramErrorClassifier", () => {
    describe("ERROR_TYPES", () => {
        test("should define all error types", () => {
            expect(TelegramErrorClassifier.ERROR_TYPES).toBeDefined();
            expect(TelegramErrorClassifier.ERROR_TYPES.TIMEOUT).toBe('TIMEOUT');
            expect(TelegramErrorClassifier.ERROR_TYPES.NOT_CONNECTED).toBe('NOT_CONNECTED');
            expect(TelegramErrorClassifier.ERROR_TYPES.CONNECTION_LOST).toBe('CONNECTION_LOST');
            expect(TelegramErrorClassifier.ERROR_TYPES.AUTH_KEY_DUPLICATED).toBe('AUTH_KEY_DUPLICATED');
            expect(TelegramErrorClassifier.ERROR_TYPES.BINARY_READER).toBe('BINARY_READER');
            expect(TelegramErrorClassifier.ERROR_TYPES.NETWORK).toBe('NETWORK');
            expect(TelegramErrorClassifier.ERROR_TYPES.RPC_ERROR).toBe('RPC_ERROR');
            expect(TelegramErrorClassifier.ERROR_TYPES.UNKNOWN).toBe('UNKNOWN');
        });
    });

    describe("classify()", () => {
        test("should classify AUTH_KEY_DUPLICATED error", () => {
            const error = new Error("AUTH_KEY_DUPLICATED");
            error.code = 406;
            expect(TelegramErrorClassifier.classify(error)).toBe('AUTH_KEY_DUPLICATED');
        });

        test("should classify timeout errors", () => {
            const timeoutErrors = [
                new Error("Request timed out"),
                new Error("timeout"),
                new Error("ETIMEDOUT"),
                new Error("ECONNRESET"),
                Object.assign(new Error("Connection timed out"), { code: 'ETIMEDOUT' })
            ];

            timeoutErrors.forEach(error => {
                expect(TelegramErrorClassifier.classify(error)).toBe('TIMEOUT');
            });
        });

        test("should classify NOT_CONNECTED errors", () => {
            const errors = [
                new Error("Not connected"),
                new Error("Connection closed"),
                new Error("Client not initialized")
            ];

            errors.forEach(error => {
                expect(TelegramErrorClassifier.classify(error)).toBe('NOT_CONNECTED');
            });
        });

        test("should classify BINARY_READER errors", () => {
            const errors = [
                new Error("readUInt32LE"),
                new Error("readInt32LE"),
                new TypeError("Cannot read property 'x' of undefined")
            ];

            errors.forEach(error => {
                expect(TelegramErrorClassifier.classify(error)).toBe('BINARY_READER');
            });
        });

        test("should classify RPC_ERROR", () => {
            const error = new Error("RPCError: something went wrong");
            expect(TelegramErrorClassifier.classify(error)).toBe('RPC_ERROR');
        });

        test("should classify NETWORK errors", () => {
            const errors = [
                new Error("ECONNREFUSED"),
                new Error("ENOTFOUND"),
                new Error("EAI_AGAIN"),
                new Error("network error"),
                new Error("socket error")
            ];

            errors.forEach(error => {
                expect(TelegramErrorClassifier.classify(error)).toBe('NETWORK');
            });
        });

        test("should classify CONNECTION_LOST errors", () => {
            const errors = [
                new Error("Connection lost"),
                new Error("Peer closed")
            ];

            errors.forEach(error => {
                expect(TelegramErrorClassifier.classify(error)).toBe('CONNECTION_LOST');
            });
        });

        test("should classify UNKNOWN errors", () => {
            const error = new Error("Some random error");
            expect(TelegramErrorClassifier.classify(error)).toBe('UNKNOWN');
        });

        test("should handle null/undefined errors", () => {
            expect(TelegramErrorClassifier.classify(null)).toBe('UNKNOWN');
            expect(TelegramErrorClassifier.classify(undefined)).toBe('UNKNOWN');
        });
    });

    describe("isRecoverable()", () => {
        test("should return false for AUTH_KEY_DUPLICATED", () => {
            expect(TelegramErrorClassifier.isRecoverable('AUTH_KEY_DUPLICATED')).toBe(false);
        });

        test("should return true for all other error types", () => {
            const recoverableTypes = [
                'TIMEOUT',
                'NOT_CONNECTED',
                'CONNECTION_LOST',
                'BINARY_READER',
                'NETWORK',
                'RPC_ERROR',
                'UNKNOWN'
            ];

            recoverableTypes.forEach(type => {
                expect(TelegramErrorClassifier.isRecoverable(type)).toBe(true);
            });
        });
    });

    describe("getReconnectStrategy()", () => {
        test("should return correct strategy for TIMEOUT", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('TIMEOUT', 0);
            expect(strategy.type).toBe('lightweight');
            expect(strategy.baseDelay).toBe(10000);
            expect(strategy.maxDelay).toBe(120000);
            expect(strategy.maxRetries).toBe(5);
            expect(strategy.backoffMultiplier).toBe(2.5);
            expect(strategy.delay).toBe(10000); // baseDelay * multiplier^0
            expect(strategy.shouldRetry).toBe(true);
        });

        test("should return correct strategy for NOT_CONNECTED", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('NOT_CONNECTED', 0);
            expect(strategy.type).toBe('lightweight');
            expect(strategy.baseDelay).toBe(5000);
            expect(strategy.maxDelay).toBe(60000);
            expect(strategy.maxRetries).toBe(8);
        });

        test("should return correct strategy for NETWORK", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('NETWORK', 0);
            expect(strategy.type).toBe('lightweight');
            expect(strategy.maxDelay).toBe(180000); // 3 minutes
            expect(strategy.maxRetries).toBe(10);
        });

        test("should calculate exponential backoff correctly", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('TIMEOUT', 2);
            // baseDelay: 10000, multiplier: 2.5, failureCount: 2
            // delay = 10000 * 2.5^2 = 10000 * 6.25 = 62500
            expect(strategy.delay).toBe(62500);
        });

        test("should cap delay at maxDelay", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('TIMEOUT', 10);
            // With 10 failures, calculated delay would exceed maxDelay
            expect(strategy.delay).toBe(120000); // maxDelay
        });

        test("should return shouldRetry=false when maxRetries exceeded", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('TIMEOUT', 5);
            expect(strategy.shouldRetry).toBe(false);
        });

        test("should return default strategy for unknown error type", () => {
            const strategy = TelegramErrorClassifier.getReconnectStrategy('UNKNOWN', 0);
            expect(strategy.type).toBe('full');
            expect(strategy.baseDelay).toBe(10000);
        });
    });

    describe("shouldTripCircuitBreaker()", () => {
        test("should trip immediately for AUTH_KEY_DUPLICATED", () => {
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('AUTH_KEY_DUPLICATED', 1)).toBe(true);
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('AUTH_KEY_DUPLICATED', 0)).toBe(true);
        });

        test("should trip after 5 failures for TIMEOUT", () => {
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('TIMEOUT', 4)).toBe(false);
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('TIMEOUT', 5)).toBe(true);
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('TIMEOUT', 6)).toBe(true);
        });

        test("should trip after 8 failures for NETWORK", () => {
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('NETWORK', 7)).toBe(false);
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker('NETWORK', 8)).toBe(true);
        });

        test("should trip after 6 failures for other errors", () => {
            const otherTypes = ['NOT_CONNECTED', 'CONNECTION_LOST', 'BINARY_READER', 'RPC_ERROR', 'UNKNOWN'];
            
            otherTypes.forEach(type => {
                expect(TelegramErrorClassifier.shouldTripCircuitBreaker(type, 5)).toBe(false);
                expect(TelegramErrorClassifier.shouldTripCircuitBreaker(type, 6)).toBe(true);
            });
        });
    });

    describe("shouldResetSession()", () => {
        test("should reset session for BINARY_READER errors", () => {
            expect(TelegramErrorClassifier.shouldResetSession('BINARY_READER', 1)).toBe(true);
        });

        test("should reset session for AUTH_KEY_DUPLICATED", () => {
            expect(TelegramErrorClassifier.shouldResetSession('AUTH_KEY_DUPLICATED', 1)).toBe(true);
        });

        test("should reset session for TIMEOUT after 3 failures", () => {
            expect(TelegramErrorClassifier.shouldResetSession('TIMEOUT', 2)).toBe(false);
            expect(TelegramErrorClassifier.shouldResetSession('TIMEOUT', 3)).toBe(true);
            expect(TelegramErrorClassifier.shouldResetSession('TIMEOUT', 4)).toBe(true);
        });

        test("should not reset session for other errors", () => {
            const otherTypes = ['NOT_CONNECTED', 'CONNECTION_LOST', 'NETWORK', 'RPC_ERROR', 'UNKNOWN'];
            
            otherTypes.forEach(type => {
                expect(TelegramErrorClassifier.shouldResetSession(type, 10)).toBe(false);
            });
        });
    });

    describe("Integration scenarios", () => {
        test("should handle realistic error scenarios", () => {
            // Scenario 1: Network timeout during heavy load
            const timeoutError = new Error("Request timed out after 120s");
            const timeoutType = TelegramErrorClassifier.classify(timeoutError);
            expect(timeoutType).toBe('TIMEOUT');
            
            const strategy = TelegramErrorClassifier.getReconnectStrategy(timeoutType, 1);
            expect(strategy.type).toBe('lightweight');
            expect(strategy.delay).toBe(25000); // 10000 * 2.5^1 = 25000
            
            const shouldTrip = TelegramErrorClassifier.shouldTripCircuitBreaker(timeoutType, 4);
            expect(shouldTrip).toBe(false); // Not yet at threshold

            // Scenario 2: Connection lost
            const connectionError = new Error("Connection lost");
            const connectionType = TelegramErrorClassifier.classify(connectionError);
            expect(connectionType).toBe('CONNECTION_LOST');
            
            const shouldReset = TelegramErrorClassifier.shouldResetSession(connectionType, 1);
            expect(shouldReset).toBe(false); // Not a reset-required error

            // Scenario 3: Binary reader error (requires immediate reset)
            const binaryError = new Error("readUInt32LE");
            const binaryType = TelegramErrorClassifier.classify(binaryError);
            expect(binaryType).toBe('BINARY_READER');
            
            const shouldResetBinary = TelegramErrorClassifier.shouldResetSession(binaryType, 1);
            expect(shouldResetBinary).toBe(true);
        });

        test("should handle AUTH_KEY_DUPLICATED scenario correctly", () => {
            const error = new Error("AUTH_KEY_DUPLICATED");
            error.code = 406;
            
            const errorType = TelegramErrorClassifier.classify(error);
            expect(errorType).toBe('AUTH_KEY_DUPLICATED');
            
            expect(TelegramErrorClassifier.isRecoverable(errorType)).toBe(false);
            expect(TelegramErrorClassifier.shouldTripCircuitBreaker(errorType, 1)).toBe(true);
            expect(TelegramErrorClassifier.shouldSkipReconnect(errorType)).toBe(true);
            expect(TelegramErrorClassifier.shouldResetSession(errorType, 1)).toBe(true);
        });
    });
});