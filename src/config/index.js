import fs from "fs";
import path from "path";

/**
 * --- 1. 基础配置与环境初始化 ---
 */
export const config = {
    apiId: parseInt(process.env.API_ID),
    apiHash: process.env.API_HASH,
    botToken: process.env.BOT_TOKEN,
    ownerId: process.env.OWNER_ID, // 7428626313
    remoteName: process.env.RCLONE_REMOTE || "mega",
    remoteFolder: process.env.REMOTE_FOLDER || "/DriveCollectorBot",
    downloadDir: "/tmp/downloads",
    configPath: "/tmp/rclone.conf",
    port: process.env.PORT || 7860,
    qstash: {
        token: process.env.QSTASH_TOKEN,
        url: process.env.QSTASH_URL,
        webhookUrl: process.env.LB_WEBHOOK_URL
    },
    oss: {
        workerUrl: process.env.OSS_WORKER_URL,
        workerSecret: process.env.OSS_WORKER_SECRET,
        r2: {
            endpoint: process.env.R2_ENDPOINT,
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            bucket: process.env.R2_BUCKET,
            publicUrl: process.env.R2_PUBLIC_URL
        }
    },
    axiom: {
        token: process.env.AXIOM_TOKEN,
        orgId: process.env.AXIOM_ORG_ID,
        dataset: process.env.AXIOM_DATASET || 'drive-collector',
    }
};

if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
if (process.env.RCLONE_CONF_BASE64) fs.writeFileSync(config.configPath, Buffer.from(process.env.RCLONE_CONF_BASE64, 'base64'));

// 缓存有效期常量
export const CACHE_TTL = 10 * 60 * 1000; // 缓存有效期 10 分钟