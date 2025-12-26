import { config } from "../config/index.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * --- R2 上传服务层 ---
 * 实现带降级逻辑的文件上传：
 * 1. 优先使用 Cloudflare Worker 中转上传 (内网直连 R2)
 * 2. 降级使用 S3 SDK 直连 API (Worker 限额或故障时)
 */
class R2Service {
    constructor() {
        // S3 SDK 配置 (用于降级)
        this.s3Client = new S3Client({
            region: "auto",
            endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });

        // Worker 上传配置
        this.workerUrl = process.env.R2_WORKER_URL;
        this.workerAuthToken = process.env.R2_WORKER_AUTH_TOKEN;
        this.workerMaxRetries = 3; // Worker 最大重试次数
    }

    /**
     * 上传文件到 R2
     * @param {string} filePath - 本地文件路径
     * @param {string} key - R2 中的文件名
     * @param {Object} options - 可选参数 { contentType, metadata }
     * @returns {Promise<Object>} { success: boolean, key?: string, etag?: string, size?: number, error?: string }
     */
    async uploadFile(filePath, key, options = {}) {
        const fs = await import('fs');

        // 检查文件是否存在
        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'File not found' };
        }

        // 获取文件信息
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const fileStream = fs.createReadStream(filePath);

        try {
            // 尝试 Worker 中转上传
            const workerResult = await this._uploadViaWorker(fileStream, key, {
                contentType: options.contentType || 'application/octet-stream',
                fileSize,
                ...options
            });

            if (workerResult.success) {
                return workerResult;
            }

            console.log(`⚠️ Worker 上传失败 (${workerResult.error})，降级到 S3 SDK...`);

            // 重置文件流
            fileStream.destroy();
            const freshStream = fs.createReadStream(filePath);

            // 使用 S3 SDK 降级上传
            return await this._uploadViaS3(freshStream, key, {
                contentType: options.contentType || 'application/octet-stream',
                metadata: options.metadata
            });

        } catch (error) {
            console.error('R2 upload critical error:', error);
            return { success: false, error: error.message };
        } finally {
            // 清理文件流
            if (fileStream && !fileStream.destroyed) {
                fileStream.destroy();
            }
        }
    }

    /**
     * 通过 Cloudflare Worker 中转上传 (优先路径)
     * @private
     */
    async _uploadViaWorker(fileStream, key, options) {
        if (!this.workerUrl || !this.workerAuthToken) {
            return { success: false, error: 'Worker configuration missing' };
        }

        for (let attempt = 1; attempt <= this.workerMaxRetries; attempt++) {
            try {
                const formData = new FormData();

                // 创建文件对象
                const file = new File([fileStream], key, {
                    type: options.contentType,
                });
                formData.append('file', file);

                // 添加元数据
                if (options.metadata) {
                    Object.entries(options.metadata).forEach(([k, v]) => {
                        formData.append(`metadata[${k}]`, v);
                    });
                }

                const response = await fetch(this.workerUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': this.workerAuthToken,
                    },
                    body: formData,
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 429) {
                        // Worker 限额，立即降级
                        return { success: false, error: 'Worker quota exceeded' };
                    }
                    throw new Error(`Worker HTTP ${response.status}: ${errorText}`);
                }

                const result = await response.json();

                if (result.success) {
                    return {
                        success: true,
                        key: result.key,
                        etag: result.etag,
                        size: result.size
                    };
                } else {
                    throw new Error(result.error || 'Worker upload failed');
                }

            } catch (error) {
                console.warn(`Worker upload attempt ${attempt} failed:`, error.message);

                if (attempt === this.workerMaxRetries) {
                    return { success: false, error: `Worker upload failed after ${this.workerMaxRetries} attempts: ${error.message}` };
                }

                // 等待后重试
                await new Promise(resolve => setTimeout(resolve, attempt * 1000));
            }
        }
    }

    /**
     * 通过 S3 SDK 直连上传 (降级路径)
     * @private
     */
    async _uploadViaS3(fileStream, key, options) {
        try {
            const command = new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
                Body: fileStream,
                ContentType: options.contentType,
                Metadata: options.metadata,
            });

            const result = await this.s3Client.send(command);

            return {
                success: true,
                key: key,
                etag: result.ETag,
                size: fileStream.readableLength || 0 // 注意：stream 可能没有长度信息
            };

        } catch (error) {
            console.error('S3 SDK upload error:', error);
            return { success: false, error: `S3 upload failed: ${error.message}` };
        }
    }

    /**
     * 检查 Worker 是否可用 (健康检查)
     * @returns {Promise<boolean>}
     */
    async isWorkerAvailable() {
        if (!this.workerUrl || !this.workerAuthToken) {
            return false;
        }

        try {
            const response = await fetch(this.workerUrl, {
                method: 'HEAD',
                headers: {
                    'Authorization': this.workerAuthToken,
                },
                signal: AbortSignal.timeout(5000), // 5秒超时
            });

            return response.ok;
        } catch (error) {
            console.warn('Worker health check failed:', error.message);
            return false;
        }
    }

    /**
     * 获取 Worker 限额状态 (如果 Worker 支持)
     * @returns {Promise<Object|null>} { remaining: number, reset: number } 或 null
     */
    async getWorkerQuota() {
        if (!this.workerUrl || !this.workerAuthToken) {
            return null;
        }

        try {
            const response = await fetch(`${this.workerUrl}/quota`, {
                method: 'GET',
                headers: {
                    'Authorization': this.workerAuthToken,
                },
                signal: AbortSignal.timeout(2000),
            });

            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            // 静默失败，Worker 可能不支持配额查询
        }

        return null;
    }
}

export const r2 = new R2Service();