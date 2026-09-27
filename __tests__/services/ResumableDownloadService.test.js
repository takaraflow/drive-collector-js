import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../src/services/logger/index.js", () => ({
  logger: {
    withModule: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}));

const { ResumableDownloadService } = await import("../../src/services/ResumableDownloadService.js");

// 构造一个 gramjs client.iterDownload 的替身:从 offset 开始按 chunk 吐字节。
function makeClient(totalBytes, { failAfter = Infinity } = {}) {
  const buf = Buffer.alloc(totalBytes, 0x61); // 'a'
  return {
    iterDownload(opts) {
      const chunk = opts.chunkSize;
      let pos = opts.offset ? Number(opts.offset) : 0;
      let emitted = 0;
      return {
        async *[Symbol.asyncIterator]() {
          while (pos < totalBytes) {
            if (emitted >= failAfter) {
              const err = new Error("Connection closed while receiving data");
              throw err;
            }
            const end = Math.min(pos + chunk, totalBytes);
            yield buf.subarray(pos, end);
            pos = end;
            emitted++;
          }
        }
      };
    }
  };
}

describe("ResumableDownloadService", () => {
  let dir;
  let svc;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumable-"));
    svc = new ResumableDownloadService();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("downloads a full file to localPath and removes the .part suffix", async () => {
    const localPath = path.join(dir, "movie.mov");
    const total = 5000;
    const res = await svc.downloadToLocal({
      client: makeClient(total),
      message: { media: {} },
      info: { size: total },
      localPath,
      chunkSize: 1000
    });

    expect(res.success).toBe(true);
    expect(res.bytes).toBe(total);
    expect(res.resumedFrom).toBe(0);
    expect(fs.statSync(localPath).size).toBe(total);
    expect(fs.existsSync(`${localPath}.part`)).toBe(false);
  });

  test("resumes from an existing .part file instead of re-downloading from zero", async () => {
    const localPath = path.join(dir, "big.mov");
    const partPath = `${localPath}.part`;
    const total = 10000;
    const chunk = 1000;

    // 先写入 3 个完整 chunk 的半成品(模拟上次断在这里)。
    fs.writeFileSync(partPath, Buffer.alloc(3000, 0x61));

    let observedOffset = null;
    const client = makeClient(total);
    const origIter = client.iterDownload.bind(client);
    client.iterDownload = (opts) => {
      observedOffset = opts.offset ? Number(opts.offset) : 0;
      return origIter(opts);
    };

    const res = await svc.downloadToLocal({
      client,
      message: { media: {} },
      info: { size: total },
      localPath,
      chunkSize: chunk
    });

    expect(observedOffset).toBe(3000); // 从 .part 末尾续,不从 0
    expect(res.resumedFrom).toBe(3000);
    expect(res.success).toBe(true);
    expect(fs.statSync(localPath).size).toBe(total);
  });

  test("keeps .part on mid-transfer disconnect so next run can resume", async () => {
    const localPath = path.join(dir, "flaky.mov");
    const partPath = `${localPath}.part`;
    const total = 10000;

    await expect(svc.downloadToLocal({
      client: makeClient(total, { failAfter: 3 }),
      message: { media: {} },
      info: { size: total },
      localPath,
      chunkSize: 1000
    })).rejects.toThrow(/Connection closed/);

    // .part 保留,localPath 未生成
    expect(fs.existsSync(partPath)).toBe(true);
    expect(fs.existsSync(localPath)).toBe(false);
    expect(fs.statSync(partPath).size).toBe(3000);
  });

  test("cleanupStalePartFiles removes only .part files older than the TTL", async () => {
    const fresh = path.join(dir, "fresh.mov.part");
    const stale = path.join(dir, "stale.mov.part");
    const keep = path.join(dir, "keep.mov"); // 非 .part,不该动
    fs.writeFileSync(fresh, "x");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(keep, "x");

    // 把 stale 的 mtime 拨到 48h 前
    const old = Date.now() - 48 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const { removed } = await svc.cleanupStalePartFiles(dir, 24 * 60 * 60 * 1000);

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(keep)).toBe(true);
  });
});
