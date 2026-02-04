# 🤖 Drive Collector MCP SaaS 接入指南

本服务实现了 **SaaS 化多租户 MCP (Model Context Protocol)** 模式。AI 客户端可以直接连接云端服务器，并在通过令牌验证后，代表您管理网盘。

## 🔑 第一步：获取您的 Access Token
1. 在 Telegram 机器人中发送 `/mcp_token`。
2. 复制生成的以 `dc_user_` 开头的令牌。

## 🌐 第二步：配置 AI 客户端 (Remote SSE)

### Claude Desktop
打开配置文件并添加以下内容：
```json
{
  "mcpServers": {
    "drive-collector": {
      "url": "https://您的云端地址/sse",
      "headers": {
        "x-api-key": "您的dc_user_令牌"
      }
    }
  }
}
```

## 🛠 提供的 AI 工具 (Tools)
*   `list_drives`: 查看您当前绑定的所有云端存储。
*   `cloud_ls`: 列出特定目录的文件列表。
*   `bind_drive_start`: 开启新网盘绑定流。

## ⚠️ 多租户隔离说明
*   **权限限制**：您的令牌仅能访问与您 Telegram ID 绑定的网盘资源。
*   **安全重置**：如果令牌泄露，再次在 Telegram 发送 `/mcp_token` 即可注销旧令牌。
