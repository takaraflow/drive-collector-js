import { vi, describe, it, expect, beforeEach } from "vitest";
import http from "node:http";

// Mock http module
vi.mock("node:http", () => ({
    default: {
        createServer: vi.fn(),
    }
}));

// 1. Mock 所有的外部依赖
const mockApiKeyRepo = {
    findUserIdByToken: vi.fn(),
};

const mockDriveRepo = {
    findByUserId: vi.fn(),
};

const mockCloudTool = {
    listRemoteFiles: vi.fn(),
};

// Mock MCP SDK
const mockServerInstance = {
    connect: vi.fn(),
    setRequestHandler: vi.fn(),
    executeTool: vi.fn(),
};

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
    Server: vi.fn().mockImplementation(function() { return mockServerInstance; }),
}));

vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
    SSEServerTransport: vi.fn().mockImplementation(() => ({
        handlePostMessage: vi.fn(),
    })),
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
    let toolHandler;

    // 加载被测模块 (由于它有 main() 立即执行，我们需要控制环境)
    beforeAll(async () => {
        vi.useFakeTimers();
        process.env.MCP_PORT = "3001";
        
        // 模拟 process.exit 防止测试退出
        const originalExit = process.exit;
        process.exit = vi.fn((code) => {
            // 不实际退出，只是记录调用
            console.log(`process.exit(${code}) was called but mocked`);
        });
        
        try {
            await import("../../src/mcp/index.js");
        } catch (error) {
            // 忽略导入错误，继续测试
            console.log("Import error (expected):", error.message);
        }
        
        // 恢复 process.exit
        process.exit = originalExit;
        
        // 捕获handler用于后续测试
        if (http.createServer.mock.calls.length > 0) {
            mockRequestHandler = http.createServer.mock.calls[0][0];
        }
        // 捕获 tool handler (CallToolRequestSchema 是第二个 setRequestHandler 调用)
        const toolCalls = mockServerInstance.setRequestHandler.mock.calls.filter(c => 
            c.length > 1 && typeof c[1] === 'function'
        );
        // 取第二个（CallToolRequestSchema），第一个是 ListToolsRequestSchema
        if (toolCalls.length >= 2) {
            toolHandler = toolCalls[1][1];
        } else if (toolCalls.length === 1) {
            toolHandler = toolCalls[0][1];
        }
    });

    beforeEach(async () => {
        // 只清除部分mock，保留关键调用记录
        mockApiKeyRepo.findUserIdByToken.mockClear();
        mockDriveRepo.findByUserId.mockClear();
    });

    it("当缺少 x-api-key 时，应返回 401 错误", async () => {
        const req = { headers: {} };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        // 使用在 beforeAll 中捕获的 handler
        await mockRequestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Missing API Key');
    });

    it("当令牌无效时，应返回 401 错误", async () => {
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue(null);
        const req = { headers: { "x-api-key": "invalid_key" } };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        // 使用在 beforeAll 中捕获的 handler
        await mockRequestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Invalid API Key');
    });

    it("身份校验通过后，Tool 调用应携带正确的 userId", async () => {
        // 模拟身份解析成功
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue("user_888");
        mockDriveRepo.findByUserId.mockResolvedValue([{ name: "My Drive" }]);

        // 使用在 beforeAll 中捕获的 tool handler
        const request = {
            params: {
                name: "list_drives",
                arguments: {},
                _metadata: { userId: "user_888" } // 模拟 SSE 注入后的元数据
            }
        };

        const result = await toolHandler(request);

        expect(mockDriveRepo.findByUserId).toHaveBeenCalledWith("user_888");
        expect(result.content[0].text).toContain("My Drive");
    });
});
