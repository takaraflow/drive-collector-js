const mockFetch = vi.fn();
const mockD1Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
};
const mockLogger = {
    withModule: vi.fn(() => mockD1Logger)
};

vi.mock('../../src/services/logger/index.js', () => ({
    logger: mockLogger
}));

const { d1 } = await import('../../src/services/d1.js');

describe('D1 observability', () => {
    const originalEnv = process.env;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mockFetch);
        process.env = {
            ...originalEnv,
            CLOUDFLARE_D1_ACCOUNT_ID: 'mock_account_id',
            CLOUDFLARE_D1_DATABASE_ID: 'mock_database_id',
            CLOUDFLARE_D1_TOKEN: 'mock_token'
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ success: true, result: [] })
        });
        d1._reset();
        await d1.initialize();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        process.env = originalEnv;
    });

    test('should keep debug messages low-cardinality and move SQL details into structured data', async () => {
        await d1._execute(
            'UPDATE tasks SET status = ?, error_msg = ? WHERE id = ?',
            ['failed', 'secret error', 'task-1']
        );

        expect(mockD1Logger.debug).toHaveBeenCalledWith('D1 request attempt', expect.objectContaining({
            attempt: 1,
            maxAttempts: 3,
            endpoint: 'cloudflare-d1-query'
        }));
        expect(mockD1Logger.debug).toHaveBeenCalledWith('D1 statement summary', {
            sql: { operation: 'UPDATE', length: 55 },
            params: [
                { type: 'string', length: 6 },
                { type: 'string', length: 12 },
                { type: 'string', length: 6 }
            ]
        });
        expect(mockD1Logger.debug).toHaveBeenCalledWith('D1 response', expect.objectContaining({
            attempt: 1,
            durationMs: expect.any(Number)
        }));

        const debugMessages = mockD1Logger.debug.mock.calls.map(call => call[0]).join(' ');
        const debugPayload = JSON.stringify(mockD1Logger.debug.mock.calls.map(call => call[1]));
        expect(debugMessages).not.toContain('error_msg');
        expect(debugMessages).not.toContain('secret error');
        expect(debugPayload).not.toContain('secret error');
    });
});
