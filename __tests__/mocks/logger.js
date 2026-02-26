export const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withModule: vi.fn().mockReturnThis(),
    withContext: vi.fn().mockReturnThis()
};
