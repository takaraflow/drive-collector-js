import { jest } from '@jest/globals';

const originalMathRandom = Math.random;

// Mock Math.random for deterministic tests
const mockMath = {
    random: jest.fn(() => 0.5), // Fixed value for deterministic tests
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    max: Math.max,
    min: Math.min,
    pow: Math.pow,
    sqrt: Math.sqrt
};

// Apply global mocks immediately for Jest setup
Object.defineProperty(Math, 'random', {
    value: mockMath.random,
    configurable: true
});

export const setupMathMocks = () => {
    Object.defineProperty(Math, 'random', {
        value: mockMath.random,
        configurable: true
    });
};

export const cleanupMathMocks = () => {
    Object.defineProperty(Math, 'random', {
        value: originalMathRandom,
        configurable: true
    });
};

export { mockMath };
