import { config } from "../config/index.js";
import { d1 } from "../services/d1.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('AuthGuard') : logger;

const ROLE_ORDER = ["banned", "user", "trusted", "admin", "owner"];
const DEFAULT_ROLE = "user";
const CACHE_MS = 5 * 60 * 1000;

const ACL = {
    // === 基础功能 ===
    "task:create": ["user", "trusted", "admin", "owner"], // 提交下载任务
    "file:view":   ["user", "trusted", "admin", "owner"], // 查看文件列表
    
    // === 敏感操作 (核心加固点) ===
    "drive:view":  ["user", "trusted", "admin", "owner"], // 查看自己的网盘配置
    "drive:edit":  ["user", "trusted", "admin", "owner"], // 修改/解绑自己的网盘
    
    // === 管理功能 ===
    "task:manage": ["admin", "owner"],                    // 管理(取消)他人的任务
    "user:manage": ["admin", "owner"],                    // 封禁/解封/提升用户
    "system:admin":["admin", "owner"],                    // 系统诊断、维护模式切换
    
    // === 特殊权限 ===
    "maintenance:bypass": ["admin", "owner"],             // 绕过维护模式
    "task:cancel:any":    ["admin", "owner"]              // 取消任意任务
};

const roleRank = (role) => ROLE_ORDER.indexOf(role);

const isRoleAllowed = (role, allowedRoles) => {
    if (!allowedRoles || allowedRoles.length === 0) return true;
    const r = roleRank(role);
    return allowedRoles.some((ar) => r >= roleRank(ar));
};

export const AuthGuard = {
    roleCache: new Map(),

    async getRole(userId) {
        if (!userId) return DEFAULT_ROLE;
        const idStr = userId.toString();
        if (config.ownerId && idStr === config.ownerId.toString()) return "owner";

        const cached = this.roleCache.get(idStr);
        const now = Date.now();
        if (cached && now - cached.ts < CACHE_MS) return cached.role;

        try {
            const row = await d1.fetchOne("SELECT role FROM user_roles WHERE user_id = ?", [idStr]);
            const role = row?.role || DEFAULT_ROLE;
            this.roleCache.set(idStr, { role, ts: now });
            return role;
        } catch (error) {
            log.error("Failed to fetch user role from DB:", error);
            return DEFAULT_ROLE;
        }
    },

    async can(userId, action) {
        const role = await this.getRole(userId);
        const allowedRoles = ACL[action];
        return isRoleAllowed(role, allowedRoles);
    },

    async setRole(userId, role) {
        if (!userId) return false;
        try {
            await d1.run("INSERT OR REPLACE INTO user_roles (user_id, role) VALUES (?, ?)", [userId.toString(), role]);
            this.roleCache.delete(userId.toString());
            return true;
        } catch (error) {
            log.error("Failed to set user role:", error);
            throw error;
        }
    },

    async removeRole(userId) {
        if (!userId) return false;
        try {
            await d1.run("DELETE FROM user_roles WHERE user_id = ?", [userId.toString()]);
            this.roleCache.delete(userId.toString());
            return true;
        } catch (error) {
            log.error("Failed to remove user role:", error);
            throw error;
        }
    }
};

