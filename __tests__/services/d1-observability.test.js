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

    test('should not put raw database identifiers in initialization logs', async () => {
        expect(mockD1Logger.info).toHaveBeenCalledWith('D1 service initialized', {
            accountConfigured: true,
            databaseConfigured: true,
            endpoint: 'cloudflare-d1-query'
        });

        const infoMessages = mockD1Logger.info.mock.calls.map(call => String(call[0])).join(' ');
        const infoPayload = JSON.stringify(mockD1Logger.info.mock.calls.map(call => call[1]));

        expect(infoMessages).not.toContain('mock_database_id');
        expect(infoPayload).not.toContain('mock_database_id');
    });

    test('should log retryable HTTP failures as warnings until retries are exhausted', async () => {
        vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
            callback();
            return 1;
        });
        mockFetch
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: () => Promise.resolve(JSON.stringify({
                    success: false,
                    errors: [{ code: 7500, message: 'internal error' }]
                }))
            })
            .mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ success: true, result: [{ results: [{ ok: 1 }] }] })
            });

        await expect(d1.fetchAll('SELECT 1')).resolves.toEqual([{ ok: 1 }]);

        expect(mockD1Logger.warn).toHaveBeenCalledWith(expect.stringContaining('D1 HTTP 500'));
        expect(mockD1Logger.error).not.toHaveBeenCalledWith(expect.stringContaining('D1 HTTP 500'));
    });

    test('should promote retryable HTTP failures to error only after max retries are exhausted', async () => {
        vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
            callback();
            return 1;
        });
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: () => Promise.resolve(JSON.stringify({
                success: false,
                errors: [{ code: 7500, message: 'internal error' }]
            }))
        });

        await expect(d1.fetchAll('SELECT 1')).rejects.toThrow('D1 HTTP 500 [7500]: internal error');

        expect(mockD1Logger.warn).toHaveBeenCalledWith(expect.stringContaining('D1 HTTP 500'));
        expect(mockD1Logger.error).toHaveBeenCalledWith(expect.stringContaining('D1 HTTP 500'));
    });
});
