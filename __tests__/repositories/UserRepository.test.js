import Database from "better-sqlite3";

let db;

const mockD1 = {
    fetchOne: vi.fn((sql, params = []) => db.prepare(sql).get(params) || null),
    fetchAll: vi.fn((sql, params = []) => db.prepare(sql).all(params))
};

vi.mock("../../src/services/d1.js", () => ({
    d1: mockD1
}));

const { UserRepository } = await import("../../src/repositories/UserRepository.js");

const insertTask = (row) => {
    db.prepare(`
        INSERT INTO tasks (id, user_id, file_name, file_size, status, created_at, updated_at)
        VALUES (@id, @user_id, @file_name, @file_size, @status, @created_at, @updated_at)
    `).run({
        file_name: "redacted.mp4",
        file_size: 10,
        created_at: 1000,
        updated_at: 1000,
        ...row
    });
};

const insertDrive = (row) => {
    db.prepare(`
        INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at)
        VALUES (@id, @user_id, @name, @type, @config_data, @status, @is_default, @created_at, @updated_at)
    `).run({
        name: "Mega",
        type: "mega",
        config_data: "{\"token\":\"secret\"}",
        status: "active",
        is_default: 0,
        created_at: 1000,
        updated_at: 1000,
        ...row
    });
};

const insertRole = (row) => {
    db.prepare(`
        INSERT INTO user_roles (user_id, role, created_at, updated_at)
        VALUES (@user_id, @role, @created_at, @updated_at)
    `).run({
        created_at: 1000,
        updated_at: 1000,
        ...row
    });
};

describe("UserRepository", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                file_name TEXT,
                file_size INTEGER DEFAULT 0,
                status TEXT NOT NULL,
                created_at INTEGER,
                updated_at INTEGER
            );
            CREATE TABLE drives (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT,
                type TEXT NOT NULL,
                config_data TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                is_default INTEGER DEFAULT 0,
                created_at INTEGER,
                updated_at INTEGER
            );
            CREATE TABLE user_roles (
                user_id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                created_at INTEGER,
                updated_at INTEGER
            );
        `);
    });

    afterEach(() => {
        db.close();
    });

    it("should derive admin users from roles, tasks, active drives, and configured owner", async () => {
        insertRole({ user_id: "admin-1", role: "admin", updated_at: 6000 });
        insertRole({ user_id: "banned-1", role: "banned", updated_at: 5000 });
        insertTask({ id: "task-1", user_id: "task-user", status: "queued", updated_at: 8000 });
        insertTask({ id: "task-2", user_id: "task-user", status: "completed", updated_at: 9000 });
        insertTask({ id: "task-3", user_id: "task-user", status: "failed", updated_at: 7000 });
        insertDrive({ id: "drive-1", user_id: "drive-user", status: "active", updated_at: 3000 });
        insertDrive({ id: "drive-2", user_id: "deleted-drive-user", status: "deleted", updated_at: 9500 });

        const result = await UserRepository.listForAdmin({
            ownerId: "owner-1",
            page: 0,
            pageSize: 8
        });

        expect(result.summary).toMatchObject({
            total: 5,
            active: 1,
            admins: 2,
            banned: 1,
            noDrive: 4
        });
        expect(result.users.map(user => user.user_id)).toEqual([
            "task-user",
            "admin-1",
            "banned-1",
            "drive-user",
            "owner-1"
        ]);

        const owner = result.users.find(user => user.user_id === "owner-1");
        expect(owner.role).toBe("owner");
        const taskUser = result.users.find(user => user.user_id === "task-user");
        expect(taskUser).toMatchObject({
            role: "user",
            task_count: 3,
            active_task_count: 1,
            completed_task_count: 1,
            failed_task_count: 1,
            active_drive_count: 0,
            last_seen_at: 9000
        });
        expect(JSON.stringify(result)).not.toContain("redacted.mp4");
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("should filter active, admin, banned, and users without active drives", async () => {
        insertRole({ user_id: "admin-1", role: "admin" });
        insertRole({ user_id: "banned-1", role: "banned" });
        insertTask({ id: "task-1", user_id: "active-user", status: "uploading", updated_at: 8000 });
        insertDrive({ id: "drive-1", user_id: "active-user", status: "active" });
        insertDrive({ id: "drive-2", user_id: "drive-only", status: "active" });

        const active = await UserRepository.listForAdmin({ filter: "active", ownerId: "owner-1" });
        expect(active.users.map(user => user.user_id)).toEqual(["active-user"]);

        const admin = await UserRepository.listForAdmin({ filter: "admin", ownerId: "owner-1" });
        expect(admin.users.map(user => user.user_id)).toEqual(["admin-1", "owner-1"]);

        const banned = await UserRepository.listForAdmin({ filter: "banned", ownerId: "owner-1" });
        expect(banned.users.map(user => user.user_id)).toEqual(["banned-1"]);

        const noDrive = await UserRepository.listForAdmin({ filter: "nodrive", ownerId: "owner-1" });
        expect(noDrive.users.map(user => user.user_id)).toEqual(["admin-1", "banned-1", "owner-1"]);
    });

    it("should clamp pagination inputs and page size", async () => {
        for (let i = 0; i < 12; i++) {
            insertRole({ user_id: `user-${i}`, role: "user", updated_at: 1000 + i });
        }

        const result = await UserRepository.listForAdmin({
            page: 99,
            pageSize: 100,
            ownerId: null
        });

        expect(result.pageSize).toBe(20);
        expect(result.page).toBe(0);
        expect(result.totalPages).toBe(1);
        expect(result.users).toHaveLength(12);

        const invalid = await UserRepository.listForAdmin({
            filter: "unknown",
            page: -4,
            pageSize: 1,
            ownerId: null
        });
        expect(invalid.filter).toBe("all");
        expect(invalid.page).toBe(0);
        expect(invalid.pageSize).toBe(5);
    });
});
