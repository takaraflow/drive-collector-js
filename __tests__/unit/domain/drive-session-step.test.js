import { describe, expect, test } from "vitest";
import {
    decodeDriveSessionStep,
    encodeDriveSessionStep,
    parseDriveSessionData
} from "../../../src/domain/drive-session-step.js";

describe("drive session step codec", () => {
    test("should encode and decode canonical drive session steps", () => {
        const encoded = encodeDriveSessionStep("google_drive", "WAIT_TOKEN");

        expect(encoded).toBe("GOOGLE_DRIVE:WAIT_TOKEN");
        expect(decodeDriveSessionStep(encoded)).toEqual({
            driveType: "google_drive",
            step: "WAIT_TOKEN"
        });
    });

    test("should decode legacy underscore format by registered provider type", () => {
        expect(decodeDriveSessionStep("GOOGLE_DRIVE_WAIT_TOKEN", ["google_drive"])).toEqual({
            driveType: "google_drive",
            step: "WAIT_TOKEN"
        });
    });

    test("should parse JSON or object session data", () => {
        expect(parseDriveSessionData({ temp_data: '{"email":"a@example.com"}' })).toEqual({ email: "a@example.com" });
        expect(parseDriveSessionData({ temp_data: { email: "a@example.com" } })).toEqual({ email: "a@example.com" });
        expect(parseDriveSessionData({ temp_data: "not-json" })).toEqual({});
    });
});
