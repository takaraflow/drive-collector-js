import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { BindingService } from "../services/drives/BindingService.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { CloudTool } from "../services/rclone.js";
import { DriveProviderFactory } from "../services/drives/index.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('MCPServer') : logger;

/**
 * MCP Server Implementation for Drive Collector
 * Exposes cloud drive management capabilities to AI models
 */
const server = new Server(
    {
        name: "drive-collector",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "list_drives",
                description: "List all cloud drives bound to a user",
                inputSchema: {
                    type: "object",
                    properties: {
                        userId: { type: "string", description: "The identifier of the user" }
                    },
                    required: ["userId"]
                }
            },
            {
                name: "cloud_ls",
                description: "List files in a specific cloud drive folder",
                inputSchema: {
                    type: "object",
                    properties: {
                        userId: { type: "string" },
                        folder: { type: "string", description: "Remote folder path (optional)" },
                        forceRefresh: { type: "boolean" }
                    },
                    required: ["userId"]
                }
            },
            {
                name: "bind_drive_start",
                description: "Start the binding process for a new cloud drive",
                inputSchema: {
                    type: "object",
                    properties: {
                        userId: { type: "string" },
                        driveType: {
                            type: "string",
                            enum: DriveProviderFactory.getSupportedTypes(),
                            description: "Type of cloud drive to bind"
                        }
                    },
                    required: ["userId", "driveType"]
                }
            }
        ],
    };
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "list_drives": {
                const drives = await DriveRepository.findByUserId(args.userId);
                return {
                    content: [{ type: "text", text: JSON.stringify(drives, null, 2) }]
                };
            }

            case "cloud_ls": {
                const files = await CloudTool.listRemoteFiles(args.userId, args.forceRefresh);
                return {
                    content: [{ type: "text", text: JSON.stringify(files, null, 2) }]
                };
            }

            case "bind_drive_start": {
                const result = await BindingService.startBinding(args.userId, args.driveType);
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

/**
 * API Key Authentication Middleware
 */
function authenticate(req, res) {
    const expectedKey = process.env.MCP_API_KEY;
    if (!expectedKey) return true; // Skip if no key configured

    const apiKey = req.headers['x-api-key'];
    if (apiKey !== expectedKey) {
        log.warn(`Unauthorized access attempt from ${req.socket.remoteAddress}`);
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized: Invalid API Key');
        return false;
    }
    return true;
}

/**
 * Start the server
 */
async function main() {
    let transport;
    const port = process.env.MCP_PORT || 3000;

    const httpServer = http.createServer(async (req, res) => {
        if (!authenticate(req, res)) return;

        if (req.method === "GET" && req.url === "/sse") {
            log.info("New SSE connection request");
            transport = new SSEServerTransport("/messages", res);
            await server.connect(transport);
        } else if (req.method === "POST" && req.url === "/messages") {
            if (!transport) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('No SSE connection established');
                return;
            }
            await transport.handlePostMessage(req, res);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    httpServer.listen(port, () => {
        log.info(`Drive Collector MCP Server running on SSE at http://localhost:${port}`);
        log.info(`- SSE endpoint: http://localhost:${port}/sse`);
        log.info(`- Message endpoint: http://localhost:${port}/messages`);
    });
}

main().catch((error) => {
    log.error("Fatal error in MCP Server:", error);
    process.exit(1);
});
