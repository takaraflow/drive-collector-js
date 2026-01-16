import { BaseDriveProvider } from "./BaseDriveProvider.js";
import { MegaProvider } from "./MegaProvider.js";
import { GoogleDriveProvider } from "./GoogleDriveProvider.js";
import { OneDriveProvider } from "./OneDriveProvider.js";
import { PikPakProvider } from "./PikPakProvider.js";
import { PCloudProvider } from "./PCloudProvider.js";
import { DropboxProvider } from "./DropboxProvider.js";
import { BoxProvider } from "./BoxProvider.js";
import { WebDAVProvider } from "./WebDAVProvider.js";
import { OSSProvider } from "./OSSProvider.js";
import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('DriveProviderFactory') : logger;

/**
 * 网盘 Provider 工厂类
 * 负责创建和管理所有网盘 Provider 实例
 */
export class DriveProviderFactory {
    static providers = new Map();

    /**
     * 注册网盘 Provider
     * @param {string} type - 网盘类型
     * @param {typeof BaseDriveProvider} ProviderClass - Provider 类
     */
    static register(type, ProviderClass) {
        if (!type || typeof type !== 'string') {
            throw new Error('DriveProviderFactory.register: type must be a non-empty string');
        }
        if (!ProviderClass || typeof ProviderClass !== 'function') {
            throw new Error('DriveProviderFactory.register: ProviderClass must be a class');
        }
        if (this.providers.has(type)) {
            throw new Error(`Provider already registered for type: ${type}`);
        }
        
        this.providers.set(type, ProviderClass);
        log.info(`Registered drive provider: ${type}`);
    }

    /**
     * 创建 Provider 实例
     * @param {string} type - 网盘类型
     * @returns {BaseDriveProvider}
     */
    static create(type) {
        const ProviderClass = this.providers.get(type);
        if (!ProviderClass) {
            throw new Error(`Provider not registered for type: ${type}`);
        }
        return new ProviderClass();
    }

    /**
     * 获取 Provider 实例（单例模式）
     * @param {string} type - 网盘类型
     * @returns {BaseDriveProvider}
     */
    static getProvider(type) {
        if (!this.instances) {
            this.instances = new Map();
        }
        
        if (!this.instances.has(type)) {
            this.instances.set(type, this.create(type));
        }
        
        return this.instances.get(type);
    }

    /**
     * 获取所有支持的网盘
     * @returns {Array<{type: string, name: string}>}
     */
    static getSupportedDrives() {
        return Array.from(this.providers.keys())
            .map(type => this.getProvider(type).getInfo());
    }

    /**
     * 检查网盘类型是否支持
     * @param {string} type - 网盘类型
     * @returns {boolean}
     */
    static isSupported(type) {
        return this.providers.has(type);
    }

    /**
     * 获取所有支持的网盘类型
     * @returns {string[]}
     */
    static getSupportedTypes() {
        return Array.from(this.providers.keys());
    }

    /**
     * 获取所有支持的网盘类型（别名）
     * @returns {string[]}
     */
    static getSupportedDriveTypes() {
        return this.getSupportedTypes();
    }

    /**
     * 获取所有注册的 Provider 实例
     * @returns {BaseDriveProvider[]}
     */
    static getAllProviders() {
        return Array.from(this.providers.entries()).map(([type, ProviderClass]) => {
            return this.getProvider(type);
        });
    }

    /**
     * 清除所有注册的 Provider（主要用于测试）
     */
    static clear() {
        this.providers.clear();
        this.instances = new Map();
    }
}

// 注册内置 Provider
DriveProviderFactory.register('mega', MegaProvider);
DriveProviderFactory.register('drive', GoogleDriveProvider);
DriveProviderFactory.register('onedrive', OneDriveProvider);
DriveProviderFactory.register('pikpak', PikPakProvider);
DriveProviderFactory.register('pcloud', PCloudProvider);
DriveProviderFactory.register('dropbox', DropboxProvider);
DriveProviderFactory.register('box', BoxProvider);
DriveProviderFactory.register('webdav', WebDAVProvider);
DriveProviderFactory.register('oss', OSSProvider);