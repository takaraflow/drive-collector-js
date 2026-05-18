import { describe, expect, it, vi } from "vitest";
import {
    extractExternalHttpUrls,
    findUnsupportedExternalLinks,
    openExternalUrlStream,
    probeExternalUrl,
    sanitizeExternalFileName
} from "../../src/processor/ExternalUrlPolicy.js";

function response(status, headers = {}, body = "") {
    return new Response(body, { status, headers });
}

describe("ExternalUrlPolicy", () => {
    it("extracts HTTP links without treating Telegram links as external downloads", () => {
        expect(extractExternalHttpUrls("https://example.com/file.zip https://t.me/c/123/4")).toEqual([
            "https://example.com/file.zip"
        ]);
    });

    it("identifies unsupported P2P and torrent links", () => {
        expect(findUnsupportedExternalLinks("magnet:?xt=urn:btih:abc https://example.com/movie.torrent")).toHaveLength(2);
    });

    it("sanitizes external file names at the boundary", () => {
        expect(sanitizeExternalFileName("../../bad:name?.mp4")).toBe("bad_name_.mp4");
        expect(sanitizeExternalFileName("")).toBe("download.bin");
    });

    it("rejects private redirect targets during probe", async () => {
        const fetchImpl = vi.fn(async (url) => {
            if (String(url) === "https://files.example.com/download") {
                return response(302, { location: "http://127.0.0.1/metadata" });
            }
            return response(200);
        });
        const lookupImpl = vi.fn(async (hostname) => {
            if (hostname === "files.example.com") return [{ address: "93.184.216.34", family: 4 }];
            return [{ address: "127.0.0.1", family: 4 }];
        });

        await expect(probeExternalUrl("https://files.example.com/download", { fetchImpl, lookupImpl }))
            .rejects.toMatchObject({ code: "EXTERNAL_URL_PRIVATE_HOST" });
    });

    it("falls back from HEAD to ranged GET when HEAD is not allowed", async () => {
        const fetchImpl = vi.fn(async (_url, init) => {
            if (init.method === "HEAD") return response(405);
            return response(206, {
                "content-range": "bytes 0-0/4096",
                "content-disposition": "attachment; filename=\"report.pdf\"",
                "content-type": "application/pdf"
            }, "x");
        });
        const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

        const result = await probeExternalUrl("https://files.example.com/report", { fetchImpl, lookupImpl });

        expect(result).toMatchObject({
            fileName: "report.pdf",
            fileSize: 4096,
            contentType: "application/pdf"
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("pins requests to the DNS result that passed SSRF validation", async () => {
        const lookupImpl = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
        const requestImpl = vi.fn(async (_url, init, options) => {
            expect(init.method).toBe("GET");
            expect(options.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
            return response(200, { "content-length": "3" }, "abc");
        });

        const result = await openExternalUrlStream("https://files.example.com/download.bin?token=secret", {
            lookupImpl,
            requestImpl
        });

        expect(result.contentLength).toBe(3);
        expect(lookupImpl).toHaveBeenCalledWith("files.example.com", { all: true, verbatim: true });
        expect(requestImpl).toHaveBeenCalledTimes(1);
    });
});
