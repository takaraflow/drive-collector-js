import { vi, describe, it, expect, beforeEach } from "vitest";
import http from "node:http";

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

// 加载被测模块 (由于它有 main() 立即执行，我们需要控制环境)
process.env.MCP_PORT = "3001";
await import("../../src/mcp/index.js");

describe("MCP Server Integration (SaaS Mode)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("当缺少 x-api-key 时，应返回 401 错误", async () => {
        const req = { headers: {} };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        // 获取创建服务器的监听函数 (从 http.createServer 获取)
        const requestHandler = http.createServer.mock.calls[0][0];
        await requestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Missing API Key');
    });

    it("当令牌无效时，应返回 401 错误", async () => {
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue(null);
        const req = { headers: { "x-api-key": "invalid_key" } };
        const res = { writeHead: vi.fn(), end: vi.fn() };

        const requestHandler = http.createServer.mock.calls[0][0];
        await requestHandler(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Invalid API Key');
    });

    it("身份校验通过后，Tool 调用应携带正确的 userId", async () => {
        // 模拟身份解析成功
        mockApiKeyRepo.findUserIdByToken.mockResolvedValue("user_888");
        mockDriveRepo.findByUserId.mockResolvedValue([{ name: "My Drive" }]);

        // 获取工具处理器 (CallToolRequestSchema 对应的逻辑)
        // 注意：index.js 第 154 行在 SSE 连接时会重写 Handler
        const toolHandler = mockServerInstance.setRequestHandler.mock.calls.find(c => c[0].method === undefined)[1];

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
