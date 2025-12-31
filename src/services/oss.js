import { config } from '../config/index.js';
import { ossHelper } from '../utils/oss-helper.js';
import fs from 'fs';
import path from 'path';
import { CloudTool } from './rclone.js';
import { logger } from './logger.js';

/**
 * --- OSS 服务层 ---
 * 实现三轨制上传逻辑：优先通过 Cloudflare Worker 隧道，其次回退到 S3 SDK 直连，最后兜底到 Rclone
 */
class OSSService {
    constructor() {
        this.workerUrl = config.oss?.workerUrl;
        this.workerSecret = config.oss?.workerSecret;
        this.hasWorker = !!(this.workerUrl && this.workerSecret);

        if (this.hasWorker) {
            logger.info('✅ OSS 服务：Worker 路径已配置');
        } else {
            logger.warn('⚠️ OSS 服务：Worker 路径未配置，将直接使用 S3 回退');
        }
    }

    /**
     * 三轨制上传文件
     * @param {string} localPath - 本地文件路径
     * @param {string} remoteName - 远程文件名
     * @param {Function} onProgress - 进度回调函数 (progress) => {}
     * @param {string} userId - 用户ID，用于Rclone兜底
     * @returns {Promise<Object>} 上传结果 { success: boolean, url?: string, error?: string }
     */
    async upload(localPath, remoteName, onProgress = null, userId = null) {
        // 验证文件存在
        if (!fs.existsSync(localPath)) {
            throw new Error(`文件不存在: ${localPath}`);
        }

        // 获取文件信息
        const stats = fs.statSync(localPath);
        const fileSize = stats.size;
        const fileName = path.basename(localPath);

        logger.info(`📤 开始上传: ${fileName} (${fileSize} bytes) -> ${remoteName}`);

        // 尝试 Worker 路径
        if (this.hasWorker) {
            try {
                const result = await this._uploadViaWorker(localPath, remoteName, fileSize, onProgress);
                if (result.success) {
                    logger.info(`✅ Worker 上传成功: ${remoteName}`);
                    return result;
                }
            } catch (error) {
                logger.warn(`⚠️ Worker 上传失败: ${error.message}，尝试 S3 回退`);
            }
        }

        // 回退到 S3 直接上传
        try {
            const result = await this._uploadViaS3(localPath, remoteName, onProgress);
            logger.info(`✅ S3 回退上传成功: ${remoteName}`);
            return result;
        } catch (error) {
            logger.error(`🚨 S3 上传失败: ${error.message}`);
            // 尝试 Rclone 兜底
            if (userId) {
                try {
                    logger.info(`🔄 尝试 Rclone 兜底上传: ${remoteName}`);
                    const rcloneResult = await this._uploadViaRclone(localPath, remoteName, userId, onProgress);
                    if (rcloneResult.success) {
                        logger.info(`✅ Rclone 兜底上传成功: ${remoteName}`);
                        return rcloneResult;
                    }
                } catch (rcloneError) {
                    logger.error(`🚨 Rclone 兜底也失败: ${rcloneError.message}`);
                }
            }
            return {
                success: false,
                error: `所有上传路径都失败: ${error.message}`
            };
        }
    }

    /**
     * 通过 Worker 上传
     * @private
     */
    async _uploadViaWorker(localPath, remoteName, fileSize, onProgress) {
        const formData = new FormData();

        // 添加文件 - 使用 fs.readFileSync 以确保 Node.js 18 兼容性
        const fileBuffer = fs.readFileSync(localPath);
        const file = new File([fileBuffer], path.basename(localPath), {
            type: 'application/octet-stream'
        });
        formData.append('file', file);
        formData.append('remoteName', remoteName);
        formData.append('secret', this.workerSecret);

        // 发送请求
        const response = await fetch(this.workerUrl, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            // 检查是否是可回退的错误
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

    /**
     * 通过 S3 直接上传
     * @private
     */
    async _uploadViaS3(localPath, remoteName, onProgress) {
        const result = await ossHelper.uploadToS3(localPath, remoteName, onProgress);

        return {
            success: true,
            url: ossHelper.getPublicUrl(remoteName),
            method: 's3',
            s3Result: result
        };
    }

    /**
     * 通过 Rclone 兜底上传
     * @private
     */
    async _uploadViaRclone(localPath, remoteName, userId, onProgress) {
        const mockTask = { userId: userId.toString(), id: 'oss_fallback_' + Date.now() };
        const result = await CloudTool.uploadFile(localPath, mockTask, (progress) => {
            if (onProgress) onProgress(progress);
        });

        return {
            success: result.success,
            url: null, // Rclone 不提供直接 URL
            method: 'rclone',
            error: result.error
        };
    }
}

export const ossService = new OSSService();