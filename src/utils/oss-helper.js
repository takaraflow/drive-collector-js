import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getConfig } from '../config/index.js';
import { logger } from '../services/logger.js';
import fs from 'fs';

/**
 * --- OSS 辅助工具 ---
 * 提供 S3 客户端初始化和分片上传功能
 */
class OSSHelper {
    constructor() {
        this.s3Client = null;
        this._initialized = false;
    }

    /**
     * 延迟初始化 S3 客户端
     */
    _init() {
        if (this._initialized) return;

        const config = getConfig();
        const ossConfig = config.oss;

        logger.debug('OSS R2 Config:', { config: ossConfig });

        if (!ossConfig?.endpoint || !ossConfig?.accessKeyId || !ossConfig?.secretAccessKey) {
            logger.warn('⚠️ OSS Helper: R2 config incomplete, S3 client initialization skipped');
            this._initialized = true;
            return;
        }

        this.s3Client = new S3Client({
            endpoint: ossConfig.endpoint,
            region: 'auto', // R2 使用 auto region
            credentials: {
                accessKeyId: ossConfig.accessKeyId,
                secretAccessKey: ossConfig.secretAccessKey,
            },
        });

        logger.info('✅ OSS Helper: S3 client initialized successfully');
        this._initialized = true;
    }

    /**
     * 执行 S3 分片上传
     */
    async uploadToS3(localPath, remoteName, onProgress = null) {
        this._init();
        
        if (!this.s3Client) {
            throw new Error('S3 客户端未初始化，请检查 R2 配置');
        }

        const config = getConfig();
        if (!config.oss?.bucket) {
            throw new Error('R2 bucket 未配置');
        }

        const fileStream = fs.createReadStream(localPath);
        const upload = new Upload({
            client: this.s3Client,
            params: {
                Bucket: config.oss.bucket,
                Key: remoteName,
                Body: fileStream,
            },
        });

        if (onProgress) {
            upload.on('httpUploadProgress', (progress) => {
                onProgress(progress);
            });
        }

        try {
            const result = await upload.done();
            logger.info(`✅ S3 upload successful: ${remoteName}`);
            return result;
        } catch (error) {
            logger.error(`🚨 S3 upload failed: ${remoteName}`, error);
            throw error;
        }
    }

    /**
     * 获取公共 URL
     */
    getPublicUrl(remoteName) {
        this._init();
        const config = getConfig();
        if (!config.oss?.publicUrl) {
            return null;
        }
        return `${config.oss.publicUrl}/${remoteName}`;
    }
}

// 延迟加载单例模式
let _instance = null;
export const getOSSHelper = () => {
    if (!_instance) _instance = new OSSHelper();
    return _instance;
};

export const ossHelper = new Proxy({}, {
    get: (target, prop) => {
        const instance = getOSSHelper();
        const value = instance[prop];
        return typeof value === 'function' ? value.bind(instance) : value;
    },
    set: (target, prop, value) => {
        const instance = getOSSHelper();
        instance[prop] = value;
        return true;
    }
});
