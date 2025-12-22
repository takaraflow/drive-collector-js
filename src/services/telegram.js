import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config/index.js";

// 初始化 Telegram 客户端单例
export const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, { connectionRetries: 5 });