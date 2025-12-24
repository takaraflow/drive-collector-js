import { jest, describe, it, expect } from "@jest/globals";

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        fetchAll: jest.fn(),
    },
}));

const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { d1 } = await import("../../src/services/d1.js");

describe("DriveRepository.findAll", () => {
    it("should call d1.fetchAll with correct SQL", async () => {
        const mockDrives = [
            { id: 1, user_id: "user1", status: "active" },
            { id: 2, user_id: "user2", status: "active" }
        ];
        d1.fetchAll.mockResolvedValue(mockDrives);

        const result = await DriveRepository.findAll();

        expect(d1.fetchAll).toHaveBeenCalledWith("SELECT * FROM user_drives WHERE status = 'active'");
        expect(result).toEqual(mockDrives);
    });

    it("should return empty array and log error on failure", async () => {
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        d1.fetchAll.mockRejectedValue(new Error("DB Error"));

        const result = await DriveRepository.findAll();

        expect(result).toEqual([]);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});