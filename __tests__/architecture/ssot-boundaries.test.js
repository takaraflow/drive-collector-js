import fs from "fs";
import path from "path";
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

    test("runtime entrypoints should converge on telemetry-aware bootstrap", () => {
        const packageJson = JSON.parse(read("package.json"));
        const manifest = JSON.parse(read("manifest.json"));

        expect(read("src/bootstrap/start.js")).toContain("telemetry/tracing.js");
        expect(manifest.entrypoint).toBe("src/bootstrap/start.js");
        expect(packageJson.scripts.start).toContain("node src/bootstrap/start.js");
        expect(packageJson.scripts["start:prod"]).toContain("node src/bootstrap/start.js");
        expect(packageJson.scripts["dev:debug"]).toContain("src/bootstrap/start.js");
        expect(read("entrypoint.sh")).toContain("node src/bootstrap/start.js");
        expect(read("etc/s6-overlay/s6-rc.d/app/run")).toContain("node src/bootstrap/start.js");
    });
});
