import { describe, it, expect } from "vitest";
import { UIHelper } from "../../src/ui/templates.js";

// Telegram 单条消息上限 4096 字符;重复文件清单很容易撞线,所以把这条钉死。
describe("UIHelper.renderDupScanPage", () => {
    const hashScan = (groups) => ({ groups, hashed: 100, total: 100, hashAvailable: true });

    it("stays under the 4096 char limit with worst-case long paths", () => {
        const groups = Array.from({ length: 3 }, (_, g) => ({
            basis: "hash",
            algo: "md5",
            size: 123456789,
            paths: Array.from({ length: 6 }, (_, i) =>
                `极长目录名重复测试/${g}/子目录${i}/${"很长的文件名".repeat(12)}.mp4`)
        }));

        const { text } = UIHelper.renderDupScanPage("Mega-averylongemail@example.com", hashScan(groups), 0);
        expect(text.length).toBeLessThan(4096);
    });

    it("collapses a 5000-member group instead of listing every path", () => {
        const groups = [{
            basis: "size",
            algo: null,
            size: 1,
            paths: Array.from({ length: 5000 }, (_, i) => `file-${i}.jpg`)
        }];

        const { text, buttons } = UIHelper.renderDupScanPage("Mega-x", hashScan(groups), 0);

        expect(text).toContain("另有 4994 份");
        expect(text.length).toBeLessThan(4096);
        expect(buttons.length).toBe(1);
    });

    it("says hashes are unavailable instead of implying the drive is clean", () => {
        const { text } = UIHelper.renderDupScanPage("Mega-x", {
            groups: [],
            hashed: 0,
            total: 800,
            hashAvailable: false
        }, 0);

        expect(text).toContain("不返回内容哈希");
        expect(text).toContain("内容可能不同");
        expect(text).not.toContain("{{");
    });

    it("labels a size-based group as possibly-different content", () => {
        const { text } = UIHelper.renderDupScanPage("Mega-x", {
            groups: [{ basis: "size", algo: null, size: 1024, paths: ["a.mp4", "b.mp4"] }],
            hashed: 0,
            total: 2,
            hashAvailable: false
        }, 0);

        expect(text).toContain("相同大小");
        expect(text).toContain("内容可能不同");
    });

    it("pages through groups with prev/next buttons", () => {
        const groups = Array.from({ length: 7 }, (_, i) => ({
            basis: "hash", algo: "md5", size: 10, paths: [`f${i}a`, `f${i}b`]
        }));
        const scan = hashScan(groups);

        const first = UIHelper.renderDupScanPage("Mega-x", scan, 0);
        expect(first.page).toBe(0);
        expect(first.totalPages).toBe(3);

        const last = UIHelper.renderDupScanPage("Mega-x", scan, 2);
        expect(last.page).toBe(2);
    });

    it("reminds the user to verify before deleting", () => {
        const { text } = UIHelper.renderDupScanPage("Mega-x", hashScan([
            { basis: "hash", algo: "md5", size: 10, paths: ["a", "b"] }
        ]), 0);

        expect(text).toContain("请自行到网盘里确认后再删除");
    });
});
