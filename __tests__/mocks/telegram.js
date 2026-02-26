export const mockClient = {
    editMessage: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    getMessages: vi.fn().mockResolvedValue([]),
    invoke: vi.fn().mockResolvedValue(true),
    start: vi.fn().mockResolvedValue(true),
    addEventHandler: vi.fn()
};

export const mockTelegram = {
    client: mockClient,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(true),
    clearSession: vi.fn().mockResolvedValue(true)
};
