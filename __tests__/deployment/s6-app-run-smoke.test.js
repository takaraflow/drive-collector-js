import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, test } from "vitest";

const root = process.cwd();
const tempDirs = [];

function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s6-app-run-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe("s6 app run smoke", () => {
    test("should start bootstrap from APP_DIR when s6 invokes it from a service directory", () => {
        const tempDir = makeTempDir();
        const fakeBin = path.join(tempDir, "bin");
        const serviceDir = path.join(tempDir, "servicedirs", "app");
        const captureFile = path.join(tempDir, "node-capture.txt");
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(serviceDir, { recursive: true });

        const fakeNode = path.join(fakeBin, "node");
        fs.writeFileSync(fakeNode, [
            "#!/bin/sh",
            "{",
            "  printf 'cwd=%s\\n' \"$(pwd)\"",
            "  printf 'args=%s\\n' \"$*\"",
            "  printf 'NODE_MODE=%s\\n' \"$NODE_MODE\"",
            "  printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
            "} > \"$CAPTURE_FILE\"",
            "exit 0",
            ""
        ].join("\n"));
        fs.chmodSync(fakeNode, 0o755);

        const result = spawnSync("sh", [path.join(root, "etc/s6-overlay/s6-rc.d/app/run")], {
            cwd: serviceDir,
            env: {
                ...process.env,
                APP_DIR: root,
                CAPTURE_FILE: captureFile,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
            },
            encoding: "utf8"
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("[s6-app] === RUN SCRIPT EXECUTED ===");

        const capture = fs.readFileSync(captureFile, "utf8");
        expect(capture).toContain(`cwd=${root}`);
        expect(capture).toContain("args=src/bootstrap/start.js");
        expect(capture).toContain("NODE_MODE=all");
        expect(capture).toContain("--max-old-space-size=512");
    });

    test("should preserve platform-provided NODE_MODE", () => {
        const tempDir = makeTempDir();
        const fakeBin = path.join(tempDir, "bin");
        const serviceDir = path.join(tempDir, "servicedirs", "app");
        const captureFile = path.join(tempDir, "node-capture.txt");
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.mkdirSync(serviceDir, { recursive: true });

        const fakeNode = path.join(fakeBin, "node");
        fs.writeFileSync(fakeNode, [
            "#!/bin/sh",
            "printf 'NODE_MODE=%s\\n' \"$NODE_MODE\" > \"$CAPTURE_FILE\"",
            "exit 0",
            ""
        ].join("\n"));
        fs.chmodSync(fakeNode, 0o755);

        const result = spawnSync("sh", [path.join(root, "etc/s6-overlay/s6-rc.d/app/run")], {
            cwd: serviceDir,
            env: {
                ...process.env,
                APP_DIR: root,
                CAPTURE_FILE: captureFile,
                NODE_MODE: "processor",
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
            },
            encoding: "utf8"
        });

        expect(result.status).toBe(0);
        expect(fs.readFileSync(captureFile, "utf8")).toContain("NODE_MODE=processor");
    });

    test("should keep cloudflared idle unless tunnel is explicitly enabled", () => {
        const tempDir = makeTempDir();
        const fakeBin = path.join(tempDir, "bin");
        const captureFile = path.join(tempDir, "sleep-capture.txt");
        fs.mkdirSync(fakeBin, { recursive: true });

        const fakeSleep = path.join(fakeBin, "sleep");
        fs.writeFileSync(fakeSleep, [
            "#!/bin/sh",
            "printf 'sleep_args=%s\\n' \"$*\" > \"$CAPTURE_FILE\"",
            "exit 0",
            ""
        ].join("\n"));
        fs.chmodSync(fakeSleep, 0o755);

        const result = spawnSync("sh", [path.join(root, "etc/s6-overlay/s6-rc.d/cloudflared/run")], {
            cwd: tempDir,
            env: {
                ...process.env,
                CAPTURE_FILE: captureFile,
                TUNNEL_ENABLED: "false",
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
            },
            encoding: "utf8"
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("cloudflared disabled");
        expect(fs.readFileSync(captureFile, "utf8")).toContain("sleep_args=infinity");
    });
});
