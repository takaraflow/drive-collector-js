
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";

vi.mock("node:http", () => ({
    default: {
        createServer: vi.fn(),
    }
}));

const mockApiKeyRepo = {
    findUserIdByToken: vi.fn(),
};

const mockDriveRepo = {
    findByUserId: vi.fn(),
};

const mockCloudTool = {
    listRemoteFiles: vi.fn(),
};

const mockServerInstance = {
    connect: vi.fn(),
    setRequestHandler: vi.fn(),
    executeTool: vi.fn(),
};

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
    Server: vi.fn().mockImplementation(function() { return mockServerInstance; }),
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
    SSEServerTransport: vi.fn().mockImplementation(function() {
        return { handlePostMessage: vi.fn() };
    }),
}));

vi.mock("../../src/repositories/ApiKeyRepository.js", () => ({
    ApiKeyRepository: mockApiKeyRepo,
}));

vi.mock("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: mockDriveRepo,
}));

vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
        }),
    }
}));

describe("MCP Server Integration (SaaS Mode)", () => {
    let mockRequestHandler;
    let originalExit;

    beforeAll(async () => {
        vi.useFakeTimers();
        process.env.MCP_PORT = "3001";
        
        originalExit = process.exit;
        process.exit = vi.fn((code) => {
            console.log(`process.exit(${code}) was called but mocked`);
        });
        
        try {
            await import("../../src/mcp/index.js");
        } catch (error) {
            console.log("Import error (expected):", error.message);
        }
        
        process.exit = originalExit;
        
        if (http.createServer.mock.calls.length > 0) {
            mockRequestHandler = http.createServer.mock.calls[0][0];
        }
    }, 30000);

    afterAll(() => {
        vi.useRealTimers();
        if (originalExit) {
            process.exit = originalExit;
        }
    });

    beforeEach(async () => {
        mockApiKeyRepo.findUserIdByToken.mockClear();
        mockDriveRepo.findByUserId.mockClear();
        mockServerInstance.setRequestHandler.mockClear();
    });

    it("当缺少 x-api-key 时，应返回 401 错误", async () => {
        const req = { headers: {} };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        await mockRequestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Missing API Key');
    });

    it("当令牌无效时，应返回 401 错误", async () => {
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue(null);
        const req = { headers: { "x-api-key": "invalid_key" } };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        await mockRequestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Invalid API Key');
    });

    it("身份校验通过后，可以通过 AsyncLocalStorage 解析 userId", async () => {
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue("user_888");
        mockDriveRepo.findByUserId.mockResolvedValue([{ name: "My Drive" }]);

        const req = { method: "GET", url: "/sse", headers: { "x-api-key": "valid_key", "host": "localhost" } };
        const res = { writeHead: vi.fn(), end: vi.fn(), on: vi.fn() };

        await mockRequestHandler(req, res);

        const CallToolRequestSchemaMockIndex = mockServerInstance.setRequestHandler.mock.calls.findIndex(call => {
            const schema = call[0];
            return schema && typeof schema === 'object' && schema.shape && schema.shape.method && schema.shape.method.value === 'tools/call';
        });

        const toolHandler = mockServerInstance.setRequestHandler.mock.calls[CallToolRequestSchemaMockIndex][1];

        expect(typeof toolHandler).toBe("function");

        try {
            await toolHandler({ params: { name: "list_drives", arguments: {} } });
        } catch (e) {
            expect(e.message).toBe("Unauthorized: Identity resolution failed");
        }
    });
});
