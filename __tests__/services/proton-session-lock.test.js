import { describe, it, expect } from "vitest";
import { _driveSessionMutex } from "../../src/services/rclone.js";
import { isProtonRefreshTokenDead } from "../../src/domain/rclone-error.js";

// Regression guards for the Proton refresh_token race fix.
// See PR: 重试前重置 / per-drive session lock + Code=10013 self-heal.

describe("per-drive session mutex keying", () => {
    const run = async (key, active, peak) => {
        const release = await _driveSessionMutex(key).acquire();
        active.n++;
        peak.n = Math.max(peak.n, active.n);
        await new Promise((r) => setTimeout(r, 10));
        active.n--;
        release();
    };

    it("serializes concurrent ops on the SAME (type,userId) key — peak concurrency 1", async () => {
        const active = { n: 0 };
        const peak = { n: 0 };
        const key = "drive-session:protondrive:u1";
        await Promise.all([run(key, active, peak), run(key, active, peak), run(key, active, peak)]);
        // If the lock were global or missing, peak would be >1. If keyed correctly, exactly 1.
        expect(peak.n).toBe(1);
    });

    it("does NOT serialize different drives/users — peak concurrency 2 (no throughput hit)", async () => {
        const active = { n: 0 };
        const peak = { n: 0 };
        await Promise.all([
            run("drive-session:protondrive:uA", active, peak),
            run("drive-session:protondrive:uB", active, peak)
        ]);
        expect(peak.n).toBe(2);
    });

    it("returns a stable Mutex instance per key", () => {
        expect(_driveSessionMutex("drive-session:protondrive:u9")).toBe(
            _driveSessionMutex("drive-session:protondrive:u9")
        );
        expect(_driveSessionMutex("drive-session:protondrive:u9")).not.toBe(
            _driveSessionMutex("drive-session:protondrive:u8")
        );
    });
});

describe("isProtonRefreshTokenDead — narrow dead-refresh-token signal", () => {
    it("matches the real Proton dead-refresh-token errors", () => {
        expect(isProtonRefreshTokenDead("Failed to copy: ... (Code=10013, Status=422)")).toBe(true);
        expect(isProtonRefreshTokenDead("Invalid refresh token")).toBe(true);
    });

    it("must NOT fire on recoverable/other auth signals (or we'd clear a valid session)", () => {
        expect(isProtonRefreshTokenDead("Multi-factor authentication required")).toBe(false);
        expect(isProtonRefreshTokenDead("requires a 2FA code")).toBe(false);
        expect(isProtonRefreshTokenDead("403 unauthorized")).toBe(false);
        expect(isProtonRefreshTokenDead("bad password")).toBe(false);
        expect(isProtonRefreshTokenDead("invalid access token")).toBe(false);
        expect(isProtonRefreshTokenDead("")).toBe(false);
        expect(isProtonRefreshTokenDead(null)).toBe(false);
    });
});
