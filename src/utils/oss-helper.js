import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config/index.js';
import fs from 'fs';

/**
 * --- OSS 辅助工具 ---
 * 提供 S3 客户端初始化和分片上传功能
 */
class OSSHelper {
    constructor() {
        this.s3Client = null;
        this._initS3Client();
    }

    /**
     * 初始化 S3 客户端
     */
    _initS3Client() {
        if (!config.oss?.r2?.endpoint || !config.oss?.r2?.accessKeyId || !config.oss?.r2?.secretAccessKey) {
            console.warn('⚠️ OSS Helper: R2 配置不完整，S3 客户端初始化跳过');
            return;
        }

        this.s3Client = new S3Client({
            endpoint: config.oss.r2.endpoint,
            region: 'auto', // R2 使用 auto region
            credentials: {
                accessKeyId: config.oss.r2.accessKeyId,
                secretAccessKey: config.oss.r2.secretAccessKey,
            },
        });

        console.log('✅ OSS Helper: S3 客户端初始化完成');
    }

    /**
     * 执行 S3 分片上传
     * @param {string} localPath - 本地文件路径
     * @param {string} remoteName - 远程文件名
     * @param {Function} onProgress - 进度回调函数 (progress) => {}
     * @returns {Promise<Object>} 上传结果
     */
    async uploadToS3(localPath, remoteName, onProgress = null) {
        if (!this.s3Client) {
            throw new Error('S3 客户端未初始化，请检查 R2 配置');
        }

        if (!config.oss?.r2?.bucket) {
            throw new Error('R2 bucket 未配置');
        }

        const fileStream = fs.createReadStream(localPath);
        const upload = new Upload({
            client: this.s3Client,
            params: {
                Bucket: config.oss.r2.bucket,
                Key: remoteName,
                Body: fileStream,
            },
        });

        // 绑定进度事件
        if (onProgress) {
            upload.on('httpUploadProgress', (progress) => {
                onProgress(progress);
            });
        }

        try {
            const result = await upload.done();
            console.log(`✅ S3 上传成功: ${remoteName}`);
            return result;
        } catch (error) {
            console.error(`🚨 S3 上传失败: ${remoteName}`, error);
            throw error;
        }
    }

    /**
     * 获取公共 URL
     * @param {string} remoteName - 远程文件名
     * @returns {string} 公共访问 URL
     */
    getPublicUrl(remoteName) {
        if (!config.oss?.r2?.publicUrl) {
            return null;
        }
        return `${config.oss.r2.publicUrl}/${remoteName}`;
    }
}

export const ossHelper = new OSSHelper();