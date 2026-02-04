# 📖 Drive Collector MCP Server 使用指南

本服务实现了 **Model Context Protocol (MCP)** 标准，通过将原本的 Telegram Bot 核心能力封装为 AI 工具集，使 Claude、Cursor 等 AI 客户端能够直接查看、管理您的 50 多种云端存储。

## 🚀 核心能力
*   **资源发现**：AI 可以感知您已绑定的所有网盘（Google Drive, OneDrive, S3, WebDAV 等）。
*   **文件检索**：AI 可以实时调用 `ls` 指令查看网盘目录结构。
*   **自动化绑定**：AI 辅助完成复杂的网盘 Token 或 AK/SK 绑定流程。
*   **跨平台分发**：逻辑层与 Telegram 彻底解耦，支持任何 MCP 客户端。

## 🛠 安装与配置

### 1. 接入 Claude Desktop
打开您的 Claude Desktop 配置文件：
*   **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
*   **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

添加以下配置项（请确保路径为您的实际项目路径）：
```json
{
  "mcpServers": {
    "drive-collector": {
      "command": "node",
      "args": ["/绝对路径/到/您的项目/src/mcp/index.js"],
      "env": {
        "NODE_ENV": "prod"
      }
    }
  }
}
```

## 🧰 提供的工具 (Tools)

| 工具名称 | 描述 | 主要参数 |
| :--- | :--- | :--- |
| `list_drives` | 获取当前用户绑定的所有网盘列表 | `userId` |
| `cloud_ls` | 列出指定网盘或目录下的文件 | `userId`, `folder`, `forceRefresh` |
| `bind_drive_start` | 开启一个新网盘的绑定流程 | `userId`, `driveType` |

## 💡 使用场景示例

### 场景：查询文件
> **用户**: "帮我看看我网盘根目录里都有什么文件？"
> **AI 调用**: `cloud_ls(userId="your_id")`
> **AI 回复**: "您的根目录下有：Backup, Photos, Work..."

## ⚠️ 安全性提醒
MCP 工具直接操作您的存储数据库，请务必在私有且受信任的环境中使用。
