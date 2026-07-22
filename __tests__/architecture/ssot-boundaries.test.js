import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function listFiles(dir, predicate = () => true) {
    const base = path.join(root, dir);
    const result = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (predicate(fullPath)) {
                result.push(path.relative(root, fullPath));
            }
        }
    };
    walk(base);
    return result;
}

describe("SSOT architecture boundaries", () => {
    test("runtime services should not read legacy default_drive settings", () => {
        const offenders = listFiles("src", file => file.endsWith(".js"))
            .filter(file => read(file).includes("default_drive_"));

        expect(offenders).toEqual([]);
    });

    test("TaskManager should not read queue metadata from task rows", () => {
        expect(read("src/processor/TaskManager.js")).not.toContain("source_data");
    });

    test("queue payload shape should be owned by the queue contract", () => {
        const files = [
            "src/services/QueueService.js",
            "src/webhook/WebhookRouter.js",
            "src/processor/TaskManager.js",
            "src/processor/TaskManager/TaskManager.download.js"
        ];

        files.forEach(file => {
            expect(read(file)).toContain("task-queue-contract.js");
        });
    });

    test("critical runtime paths should not read process.env directly", () => {
        const allowed = new Set([
            "src/config/index.js",
            "src/config/env.js",
            "src/config/runtime.js",
            "src/services/d1.js",
            "src/dispatcher/bootstrap.js",
            "src/services/rclone.js"
        ]);

        const offenders = listFiles("src", file => file.endsWith(".js"))
            .filter(file => !allowed.has(file))
            .filter(file => read(file).includes("process.env"))
            .filter(file => /src\/(processor|dispatcher|modules|repositories|services\/(QueueService|MediaGroupBuffer))/.test(file));

        expect(offenders).toEqual([]);
    });

    test("database schema contract should have explicit runtime check and migration scripts", () => {
        expect(read("src/bootstrap/AppInitializer.js")).toContain("ensureDatabaseSchemaReady");
        expect(read("scripts/db-migrate.js")).toContain("migrateDatabaseSchema");
        expect(read("package.json")).toContain('"db:migrate"');
        expect(read("package.json")).toContain('"db:check"');
    });

    test("task status read APIs should not use derived state as canonical fallback", () => {
        const repository = read("src/repositories/TaskRepository.js");
        const statusFull = repository.slice(
            repository.indexOf("static async getTaskStatusFull"),
            repository.indexOf("static async getTaskStatusBatch")
        );
        const statusBatch = repository.slice(
            repository.indexOf("static async getTaskStatusBatch"),
            repository.indexOf("static async getTaskInfo")
        );

        expect(statusFull).not.toContain("getTaskStatusSynchronized");
        expect(statusFull).not.toContain("getTaskStatusFromCache");
        expect(statusFull).not.toContain("pendingUpdates.get");
        expect(statusBatch).not.toContain("consistent-cache-read");
        expect(statusBatch).not.toContain("pendingUpdates.get");
    });

    test("runtime entrypoints should converge on telemetry-aware bootstrap", () => {
        const packageJson = JSON.parse(read("package.json"));
        const manifest = JSON.parse(read("manifest.json"));
        const s6AppRun = read("etc/s6-overlay/s6-rc.d/app/run");
        const s6CloudflaredRun = read("etc/s6-overlay/s6-rc.d/cloudflared/run");

        expect(read("src/bootstrap/start.js")).toContain("telemetry/tracing.js");
        expect(manifest.entrypoint).toBe("src/bootstrap/start.js");
        expect(packageJson.scripts.start).toContain("node src/bootstrap/start.js");
        expect(packageJson.scripts["start:prod"]).toContain("node src/bootstrap/start.js");
        expect(packageJson.scripts["dev:debug"]).toContain("src/bootstrap/start.js");
        expect(read("entrypoint.sh")).toContain("node src/bootstrap/start.js");
        expect(s6AppRun).toContain("node src/bootstrap/start.js");
        expect(s6AppRun).toContain('APP_DIR="${APP_DIR:-/app}"');
        expect(s6AppRun).toContain('cd "$APP_DIR"');
        expect(s6AppRun.indexOf('cd "$APP_DIR"')).toBeLessThan(s6AppRun.indexOf("node src/bootstrap/start.js"));
        expect(s6AppRun).toMatch(/export .*NODE_OPTIONS/);
        expect(s6AppRun).toContain('NODE_MODE="${NODE_MODE:-all}"');
        expect(s6AppRun).not.toContain("NODE_MODE=all exec node");
        expect(s6AppRun.startsWith("#!/command/with-contenv sh")).toBe(true);
        expect(s6CloudflaredRun.startsWith("#!/command/with-contenv sh")).toBe(true);
        expect(s6CloudflaredRun).toContain('TUNNEL_ENABLED:-false');
    });

    test("deployment shell entrypoints should remain syntactically valid", () => {
        [
            "entrypoint.sh",
            "etc/s6-overlay/s6-rc.d/app/run",
            "etc/s6-overlay/s6-rc.d/app/finish",
            "etc/s6-overlay/s6-rc.d/cloudflared/run"
        ].forEach(file => {
            expect(() => execFileSync("sh", ["-n", path.join(root, file)])).not.toThrow();
        });
    });

    test("package lock version should match package metadata", () => {
        const packageJson = JSON.parse(read("package.json"));
        const packageLock = JSON.parse(read("package-lock.json"));

        expect(packageLock.version).toBe(packageJson.version);
        expect(packageLock.packages[""].version).toBe(packageJson.version);
    });
});
