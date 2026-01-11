import { getConfig } from '../config/index.js';
import { ossHelper } from '../utils/oss-helper.js';
import fs from 'fs';
import path from 'path';
import { CloudTool } from './rclone.js';
import { logger } from './logger/index.js';

const log = logger.withModule ? logger.withModule('OSSService') : logger;

/**
 * --- OSS 服务层 ---
 * 实现三轨制上传逻辑：优先通过 Cloudflare Worker 隧道，其次回退到 S3 SDK 直连，最后兜底到 Rclone
 */
export class OSSService {
    constructor() {
        this._initialized = false;
        this.workerUrl = null;
        this.workerSecret = null;
        this.hasWorker = false;
    }

    /**
     * 延迟初始化：确保在 initConfig() 之后执行
     */
    _init() {
        if (this._initialized) return;
        
        const config = getConfig();
        this.workerUrl = config.oss?.workerUrl;
        this.workerSecret = config.oss?.workerSecret;
        this.hasWorker = !!(this.workerUrl && this.workerSecret);

        if (this.hasWorker) {
            log.info('✅ OSS 服务：Worker 路径已配置');
        } else {
            log.warn('⚠️ OSS 服务：Worker 路径未配置，将直接使用 S3 回退');
        }
        this._initialized = true;
    }

    /**
     * 三轨制上传文件
     */
    async upload(localPath, remoteName, onProgress = null, userId = null) {
        this._init();
        
        if (!fs.existsSync(localPath)) {
            throw new Error(`文件不存在: ${localPath}`);
        }

        const stats = fs.statSync(localPath);
        const fileSize = stats.size;
        const fileName = path.basename(localPath);

        log.info(`📤 开始上传: ${fileName} (${fileSize} bytes) -> ${remoteName}`);

        if (this.hasWorker) {
            try {
                const result = await this._uploadViaWorker(localPath, remoteName, fileSize, onProgress);
                if (result.success) {
                    log.info(`✅ Worker 上传成功: ${remoteName}`);
                    return result;
                }
            } catch (error) {
                log.warn(`⚠️ Worker 上传失败: ${error.message}，尝试 S3 回退`);
            }
        }

        try {
            const result = await this._uploadViaS3(localPath, remoteName, onProgress);
            log.info(`✅ S3 回退上传成功: ${remoteName}`);
            return result;
        } catch (error) {
            log.error(`🚨 S3 上传失败: ${error.message}`);
            if (userId) {
                try {
                    log.info(`🔄 尝试 Rclone 兜底上传: ${remoteName}`);
                    const rcloneResult = await this._uploadViaRclone(localPath, remoteName, userId, onProgress);
                    if (rcloneResult.success) {
                        log.info(`✅ Rclone 兜底上传成功: ${remoteName}`);
                        return rcloneResult;
                    }
                } catch (rcloneError) {
                    log.error(`🚨 Rclone 兜底也失败: ${rcloneError.message}`);
                }
            }
            return {
                success: false,
                error: `所有上传路径都失败: ${error.message}`
            };
        }
    }

    async _uploadViaWorker(localPath, remoteName, fileSize, onProgress) {
        const formData = new FormData();
        const fileBuffer = fs.readFileSync(localPath);
        const file = new File([fileBuffer], path.basename(localPath), {
            type: 'application/octet-stream'
        });
        formData.append('file', file);
        formData.append('remoteName', remoteName);
        formData.append('secret', this.workerSecret);

        const response = await fetch(this.workerUrl, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            if (response.status === 429 || response.status === 503 || response.status >= 500) {
                throw new Error(`Worker 限制或错误 (状态码: ${response.status})`);
            }
            throw new Error(`Worker 上传失败 (状态码: ${response.status})`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(`Worker 响应错误: ${result.error || '未知错误'}`);
        }

        return {
            success: true,
            url: result.url || ossHelper.getPublicUrl(remoteName),
            method: 'worker'
        };
    }

    async _uploadViaS3(localPath, remoteName, onProgress) {
        const result = await ossHelper.uploadToS3(localPath, remoteName, onProgress);
        return {
            success: true,
            url: ossHelper.getPublicUrl(remoteName),
            method: 's3',
            s3Result: result
        };
    }

    async _uploadViaRclone(localPath, remoteName, userId, onProgress) {
        const mockTask = { userId: userId.toString(), id: 'oss_fallback_' + Date.now() };
        const result = await CloudTool.uploadFile(localPath, mockTask, (progress) => {
            if (onProgress) onProgress(progress);
        });

        return {
            success: result.success,
            url: null,
            method: 'rclone',
            error: result.error
        };
    }
}

// 延迟加载单例模式
let _instance = null;
export const getOSS = () => {
    if (!_instance) _instance = new OSSService();
    return _instance;
};

export const ossService = new Proxy({}, {
    get: (target, prop) => {
        const instance = getOSS();
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
    }
});
