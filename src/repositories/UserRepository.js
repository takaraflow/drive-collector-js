import { d1 } from "../services/d1.js";
import { TASK_ACTIVE_STATUSES } from "../domain/task-state-machine.js";

const ADMIN_USER_FILTERS = new Set(["all", "active", "admin", "banned", "nodrive"]);
const DEFAULT_PAGE_SIZE = 8;
const MIN_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;

/**
 * Admin-facing user read model.
 *
 * There is no users table. D1 remains the SSOT by deriving users from role
 * assignments, task ownership, active drive bindings, plus the configured owner.
 */
export class UserRepository {
    static normalizeFilter(filter = "all") {
        return ADMIN_USER_FILTERS.has(filter) ? filter : "all";
    }

    static normalizePage(page = 0) {
        const numericPage = Number.parseInt(page, 10);
        return Number.isInteger(numericPage) && numericPage >= 0 ? numericPage : 0;
    }

    static normalizePageSize(pageSize = DEFAULT_PAGE_SIZE) {
        const numericPageSize = Number.parseInt(pageSize, 10);
        if (!Number.isInteger(numericPageSize)) return DEFAULT_PAGE_SIZE;
        return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, numericPageSize));
    }

    static _filterWhere(filter) {
        switch (this.normalizeFilter(filter)) {
            case "active":
                return "active_task_count > 0";
            case "admin":
                return "role IN ('owner', 'admin')";
            case "banned":
                return "role = 'banned'";
            case "nodrive":
                return "active_drive_count = 0";
            case "all":
            default:
                return "1 = 1";
        }
    }

    static _cte() {
        const activeStatusSql = TASK_ACTIVE_STATUSES.map(() => "?").join(", ");
        return `
            WITH seed_users AS (
                SELECT user_id FROM user_roles
                UNION
                SELECT user_id FROM tasks
                UNION
                SELECT user_id FROM drives WHERE status = 'active'
                UNION
                SELECT ? AS user_id WHERE ? IS NOT NULL AND ? <> ''
            ),
            task_stats AS (
                SELECT
                    user_id,
                    COUNT(*) AS task_count,
                    SUM(CASE WHEN status IN (${activeStatusSql}) THEN 1 ELSE 0 END) AS active_task_count,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_task_count,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_task_count,
                    MAX(COALESCE(updated_at, created_at, 0)) AS last_task_at
                FROM tasks
                GROUP BY user_id
            ),
            drive_stats AS (
                SELECT
                    user_id,
                    COUNT(*) AS active_drive_count,
                    MAX(COALESCE(updated_at, created_at, 0)) AS last_drive_at
                FROM drives
                WHERE status = 'active'
                GROUP BY user_id
            ),
            user_rows AS (
                SELECT
                    u.user_id,
                    CASE
                        WHEN u.user_id = ? THEN 'owner'
                        ELSE COALESCE(r.role, 'user')
                    END AS role,
                    r.created_at AS role_created_at,
                    r.updated_at AS role_updated_at,
                    COALESCE(ts.task_count, 0) AS task_count,
                    COALESCE(ts.active_task_count, 0) AS active_task_count,
                    COALESCE(ts.completed_task_count, 0) AS completed_task_count,
                    COALESCE(ts.failed_task_count, 0) AS failed_task_count,
                    COALESCE(ds.active_drive_count, 0) AS active_drive_count,
                    ts.last_task_at,
                    ds.last_drive_at,
                    MAX(
                        COALESCE(ts.last_task_at, 0),
                        COALESCE(ds.last_drive_at, 0),
                        COALESCE(r.updated_at, r.created_at, 0)
                    ) AS last_seen_at
                FROM seed_users u
                LEFT JOIN user_roles r ON r.user_id = u.user_id
                LEFT JOIN task_stats ts ON ts.user_id = u.user_id
                LEFT JOIN drive_stats ds ON ds.user_id = u.user_id
                WHERE u.user_id IS NOT NULL AND u.user_id <> ''
            )
        `;
    }

    static _cteParams(ownerId) {
        const normalizedOwnerId = ownerId ? ownerId.toString() : null;
        return [
            normalizedOwnerId,
            normalizedOwnerId,
            normalizedOwnerId,
            ...TASK_ACTIVE_STATUSES,
            normalizedOwnerId
        ];
    }

    static _normalizeRow(row) {
        return {
            user_id: row.user_id?.toString(),
            role: row.role || "user",
            role_created_at: row.role_created_at ?? null,
            role_updated_at: row.role_updated_at ?? null,
            task_count: Number(row.task_count || 0),
            active_task_count: Number(row.active_task_count || 0),
            completed_task_count: Number(row.completed_task_count || 0),
            failed_task_count: Number(row.failed_task_count || 0),
            active_drive_count: Number(row.active_drive_count || 0),
            last_task_at: row.last_task_at ?? null,
            last_drive_at: row.last_drive_at ?? null,
            last_seen_at: Number(row.last_seen_at || 0)
        };
    }

    /**
     * List users for the Telegram admin surface.
     *
     * @param {Object} options
     * @param {string} options.filter all|active|admin|banned|nodrive
     * @param {number} options.page zero-based page
     * @param {number} options.pageSize page size, clamped for Telegram
     * @param {string|null} options.ownerId configured owner id to inject and label
     */
    static async listForAdmin({ filter = "all", page = 0, pageSize = DEFAULT_PAGE_SIZE, ownerId = null } = {}) {
        const normalizedFilter = this.normalizeFilter(filter);
        const requestedPage = this.normalizePage(page);
        const safePageSize = this.normalizePageSize(pageSize);
        const where = this._filterWhere(normalizedFilter);
        const cte = this._cte();
        const baseParams = this._cteParams(ownerId);

        const summarySql = `${cte}
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN active_task_count > 0 THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN role IN ('owner', 'admin') THEN 1 ELSE 0 END), 0) AS admins,
                COALESCE(SUM(CASE WHEN role = 'banned' THEN 1 ELSE 0 END), 0) AS banned,
                COALESCE(SUM(CASE WHEN active_drive_count = 0 THEN 1 ELSE 0 END), 0) AS no_drive
            FROM user_rows`;

        const countSql = `${cte}
            SELECT COUNT(*) AS total
            FROM user_rows
            WHERE ${where}`;

        const [summaryRow, countRow] = await Promise.all([
            d1.fetchOne(summarySql, baseParams),
            d1.fetchOne(countSql, baseParams)
        ]);

        const total = Number(countRow?.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / safePageSize));
        const safePage = total === 0 ? 0 : Math.min(requestedPage, totalPages - 1);
        const offset = safePage * safePageSize;

        const usersSql = `${cte}
            SELECT
                user_id,
                role,
                role_created_at,
                role_updated_at,
                task_count,
                active_task_count,
                completed_task_count,
                failed_task_count,
                active_drive_count,
                last_task_at,
                last_drive_at,
                last_seen_at
            FROM user_rows
            WHERE ${where}
            ORDER BY
                last_seen_at DESC,
                CASE role
                    WHEN 'owner' THEN 0
                    WHEN 'admin' THEN 1
                    WHEN 'trusted' THEN 2
                    WHEN 'user' THEN 3
                    WHEN 'banned' THEN 4
                    ELSE 5
                END,
                user_id ASC
            LIMIT ? OFFSET ?`;

        const users = await d1.fetchAll(usersSql, [...baseParams, safePageSize, offset]);

        return {
            filter: normalizedFilter,
            users: (users || []).map(row => this._normalizeRow(row)),
            summary: {
                total: Number(summaryRow?.total || 0),
                active: Number(summaryRow?.active || 0),
                admins: Number(summaryRow?.admins || 0),
                banned: Number(summaryRow?.banned || 0),
                noDrive: Number(summaryRow?.no_drive || 0)
            },
            total,
            page: safePage,
            pageSize: safePageSize,
            totalPages
        };
    }
}
