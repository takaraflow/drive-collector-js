import { config } from "../config/index.js";
import { client } from "./telegram.js";
import { CloudTool } from "./rclone.js";
import { ossService } from "./oss.js";
import { UIHelper } from "../ui/templates.js";
import { getMediaInfo, updateStatus, escapeHTML, safeEdit } from "../utils/common.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { AuthGuard } from "../modules/AuthGuard.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { d1 } from "./d1.js";
import { cache } from "./CacheService.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { queueService } from "./QueueService.js";
import { logger } from "./logger/index.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { streamTransferService } from "./StreamTransferService.js";

export class DependencyContainer {
    constructor() {
        this.dependencies = {
            config,
            client,
            CloudTool,
            ossService,
            UIHelper,
            getMediaInfo,
            updateStatus,
            escapeHTML,
            safeEdit,
            runBotTask,
            runMtprotoTask,
            runBotTaskWithRetry,
            runMtprotoTaskWithRetry,
            runMtprotoFileTaskWithRetry,
            PRIORITY,
            AuthGuard,
            TaskRepository,
            d1,
            cache,
            instanceCoordinator,
            queueService,
            logger,
            STRINGS,
            format,
            streamTransferService
        };
    }

    /**
     * 获取依赖项
     * @param {string} name - 依赖项名称
     * @returns {*} 依赖项实例
     */
    get(name) {
        return this.dependencies[name];
    }

    /**
     * 注册依赖项
     * @param {string} name - 依赖项名称
     * @param {*} value - 依赖项值
     */
    register(name, value) {
        this.dependencies[name] = value;
    }

    /**
     * 获取所有依赖项
     * @returns {Object} 所有依赖项
     */
    getAll() {
        return { ...this.dependencies };
    }
}

// 创建全局依赖容器实例
export const dependencyContainer = new DependencyContainer();