import { config } from "../config/index.js";
import { d1 } from "../services/d1.js";
import logger from "../services/logger.js";

const ROLE_ORDER = ["user", "vip", "admin", "owner"];
const DEFAULT_ROLE = "user";
const CACHE_MS = 5 * 60 * 1000;

const ACL = {
    "maintenance:bypass": ["admin", "owner"],
    "task:cancel:any": ["admin", "owner"]
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
            logger.error("Failed to fetch user role from DB:", error);
            return DEFAULT_ROLE;
        }
    },

    async can(userId, action) {
        const role = await this.getRole(userId);
        const allowedRoles = ACL[action];
        return isRoleAllowed(role, allowedRoles);
    }
};

