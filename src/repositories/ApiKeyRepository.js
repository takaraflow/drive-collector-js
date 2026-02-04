import { d1 } from "../services/d1.js";
import { cache } from "../services/CacheService.js";
import { localCache } from "../utils/LocalCache.js";
import { logger } from "../services/logger/index.js";
import crypto from "crypto";

const log = logger.withModule('ApiKeyRepository');

/**
 * Repository for managing user-specific MCP API Keys
 */
export class ApiKeyRepository {
    /**
     * Get or generate a token for a user
     */
    static async getOrCreateToken(userId) {
        const cacheKey = `api_key:${userId}`;

        // 1. Try Cache
        let token = await cache.get(cacheKey);
        if (token) return token;

        // 2. Try D1
        const record = await d1.fetchOne(
            "SELECT token FROM api_keys WHERE user_id = ?",
            [userId.toString()]
        );

        if (record) {
            token = record.token;
        } else {
            // 3. Generate New
            token = this._generateSecureToken(userId);
            const now = Date.now();
            await d1.run(
                "INSERT INTO api_keys (user_id, token, created_at, updated_at) VALUES (?, ?, ?, ?)",
                [userId.toString(), token, now, now]
            );
            log.info(`Generated new API key for user ${userId}`);
        }

        // Update Cache
        await cache.set(cacheKey, token, 86400 * 7); // Cache for 7 days
        return token;
    }

    /**
     * Find userId by token
     */
    static async findUserIdByToken(token) {
        const cacheKey = `token_to_user:${token}`;

        // 1. Try LocalCache
        let userId = localCache.get(cacheKey);
        if (userId) return userId;

        // 2. Try Cache
        userId = await cache.get(cacheKey);
        if (userId) {
            localCache.set(cacheKey, userId, 300 * 1000); // 5 mins
            return userId;
        }

        // 3. Try D1
        const record = await d1.fetchOne(
            "SELECT user_id FROM api_keys WHERE token = ?",
            [token]
        );

        if (record) {
            userId = record.user_id;
            await cache.set(cacheKey, userId, 3600);
            localCache.set(cacheKey, userId, 300 * 1000);
            return userId;
        }

        return null;
    }

    /**
     * Rotate token (invalidate old, generate new)
     */
    static async rotateToken(userId) {
        const oldToken = await this.getOrCreateToken(userId);
        const newToken = this._generateSecureToken(userId);
        const now = Date.now();

        await d1.run(
            "UPDATE api_keys SET token = ?, updated_at = ? WHERE user_id = ?",
            [newToken, now, userId.toString()]
        );

        // Invalidate old caches
        await cache.delete(`api_key:${userId}`);
        await cache.delete(`token_to_user:${oldToken}`);
        localCache.del(`token_to_user:${oldToken}`);

        // Set new cache
        await cache.set(`api_key:${userId}`, newToken, 86400 * 7);

        log.info(`Rotated API key for user ${userId}`);
        return newToken;
    }

    static _generateSecureToken(userId) {
        const random = crypto.randomBytes(16).toString('hex');
        return `dc_user_${userId}_${random}`;
    }
}
