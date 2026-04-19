import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { BindingService } from "../services/drives/BindingService.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { ApiKeyRepository } from "../repositories/ApiKeyRepository.js";
import { CloudTool } from "../services/rclone.js";
import { DriveProviderFactory } from "../services/drives/index.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('MCPServer') : logger;

const mcpContext = new AsyncLocalStorage();
const transports = new Map();

/**
 * MCP Server Implementation for Drive Collector (v2.0 SaaS Edition)
 * Exposes cloud drive management capabilities with multi-tenant authentication
 */
function createMcpServer() {
    const server = new Server(
        {
            name: "drive-collector-saas",
            version: "2.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "list_drives",
                    description: "List all cloud drives bound to your account",
                    inputSchema: { type: "object", properties: {} }
                },
                {
                    name: "cloud_ls",
                    description: "List files in your cloud drive",
                    inputSchema: {
                        type: "object",
                        properties: {
                            folder: { type: "string", description: "Remote path, e.g. 'Photos/'" },
                            forceRefresh: { type: "boolean" }
                        }
                    }
                },
                {
                    name: "bind_drive_start",
                    description: "Start binding a new cloud drive",
                    inputSchema: {
                        type: "object",
                        properties: {
                            driveType: {
                                type: "string",
                                enum: DriveProviderFactory.getSupportedTypes(),
                                description: "Type of cloud drive to bind"
                            }
                        },
                        required: ["driveType"]
                    }
                }
            ],
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        const userId = mcpContext.getStore()?.userId;
        if (!userId) {
            throw new Error("Unauthorized: Identity resolution failed");
        }

        try {
            switch (name) {
                case "list_drives": {
                    const drives = await DriveRepository.findByUserId(userId);
                    return {
                        content: [{ type: "text", text: JSON.stringify(drives, null, 2) }]
                    };
                }

                case "cloud_ls": {
                    const files = await CloudTool.listRemoteFiles(userId, args.forceRefresh);
                    return {
                        content: [{ type: "text", text: JSON.stringify(files, null, 2) }]
                    };
                }

                case "bind_drive_start": {
                    const result = await BindingService.startBinding(userId, args.driveType);
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error.message}` }],
                isError: true
            };
        }
    });

    return server;
}

/**
 * Start the SaaS-enabled SSE server
 */
async function main() {
    const port = process.env.MCP_PORT || 3000;

    const httpServer = http.createServer(async (req, res) => {
        // 1. Authenticate & Resolve User
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            res.writeHead(401);
            res.end('Missing API Key');
            return;
        }

        const userId = await ApiKeyRepository.findUserIdByToken(apiKey);
        if (!userId) {
            res.writeHead(401);
            res.end('Invalid API Key');
            return;
        }

        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // Wrap the execution context to propagate userId to tool handlers
        await mcpContext.run({ userId }, async () => {
            // 2. Route Handling
            if (req.method === "GET" && parsedUrl.pathname === "/sse") {
                log.info(`New SaaS SSE connection: User ${userId}`);
                const sseTransport = new SSEServerTransport("/messages", res);

                sseTransport.onclose = () => {
                    transports.delete(sseTransport.sessionId);
                };

                transports.set(sseTransport.sessionId, sseTransport);
                const server = createMcpServer();
                await server.connect(sseTransport);

            } else if (req.method === "POST" && parsedUrl.pathname === "/messages") {
                const sessionId = parsedUrl.searchParams.get('sessionId');
                const sseTransport = transports.get(sessionId);

                if (!sseTransport) {
                    res.writeHead(400);
                    res.end('No active SSE session for this ID');
                    return;
                }

                await sseTransport.handlePostMessage(req, res);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    });

    httpServer.listen(port, () => {
        log.info(`Drive Collector SaaS MCP Server running at http://localhost:${port}/sse`);
    });
}

main().catch((error) => {
    log.error("Fatal SaaS MCP error:", error);
    process.exit(1);
});
