import { EventEmitter } from "events";
import { describe, expect, test, vi, beforeEach } from "vitest";

let config = {
  directTransfer: { enabled: true, fallbackToLocal: true },
  remoteName: "mega",
  oss: {}
};

vi.mock("../../src/config/index.js", () => ({
  getConfig: () => config
}));

vi.mock("../../src/services/logger/index.js", () => ({
  logger: {
    withModule: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}));

const { DirectTransferService } = await import("../../src/services/DirectTransferService.js");

function createProcess({ exitCode = 0, stderr = "" } = {}) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.complete = () => {
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  };
  return proc;
}

function createWritable(proc = null) {
  const writable = new EventEmitter();
  writable.writable = true;
  writable.destroyed = false;
  writable.closed = false;
  writable.write = vi.fn((_chunk, callback) => {
    callback?.();
    return true;
  });
  writable.end = vi.fn(() => {
    writable.closed = true;
    queueMicrotask(() => {
      writable.emit("finish");
      proc?.complete?.();
    });
  });
  writable.destroy = vi.fn(() => {
    writable.destroyed = true;
  });
  return writable;
}

describe("DirectTransferService", () => {
  let cloudTool;
  let client;
  let service;

  beforeEach(() => {
    config = {
      directTransfer: { enabled: true, fallbackToLocal: true },
      remoteName: "mega",
      oss: {}
    };
    cloudTool = {
      sanitizeRemoteFileName: vi.fn((name) => String(name).replace(/^.*\//, "") || "unnamed.bin"),
      createRcatStream: vi.fn(),
      moveRemoteFile: vi.fn(),
      deleteRemoteFile: vi.fn().mockResolvedValue({ success: true }),
      getRemoteFileInfo: vi.fn().mockResolvedValue(null)
    };
    client = {
      iterDownload: vi.fn(() => (async function* () {
        yield Buffer.from("hello ");
        yield Buffer.from("world");
      })())
    };
    service = new DirectTransferService(cloudTool, { validationRetryDelayMs: 0 });
  });

  test("streams Telegram chunks into rcat, moves staging file, and validates remote size", async () => {
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({
      stdin,
      proc,
      fileName: ".stage.part.movie.mkv"
    });
    cloudTool.moveRemoteFile.mockResolvedValue({ success: true, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 11 });
    const onProgress = vi.fn();

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-1", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "../movie.mkv",
      chunkSize: 4,
      onProgress
    });

    expect(result).toMatchObject({ success: true, method: "direct_stream", fileName: "movie.mkv", bytes: 11 });
    expect(client.iterDownload).toHaveBeenCalledWith(expect.objectContaining({
      requestSize: 4,
      chunkSize: 4,
      stride: 4
    }));
    expect(stdin.write).toHaveBeenCalledTimes(2);
    expect(stdin.end).toHaveBeenCalledTimes(1);
    expect(cloudTool.moveRemoteFile).toHaveBeenCalledWith(".stage.part.movie.mkv", "movie.mkv", "user-1");
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ bytes: 11, size: 11 }));
  });

  test("falls back and cleans remote staging when rcat fails", async () => {
    const proc = createProcess({ exitCode: 1, stderr: "backend does not support rcat" });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-2-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-2", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({ success: false, fallback: true });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("skips direct transfer for OSS/R2 local staging targets", () => {
    config = {
      directTransfer: { enabled: true, fallbackToLocal: true },
      remoteName: "r2",
      oss: { bucket: "bucket" }
    };

    expect(service.canAttempt(config)).toEqual({
      supported: false,
      reason: "oss-local-staging-required"
    });
    expect(service.canAttempt(config, { driveType: "oss" })).toEqual({
      supported: false,
      reason: "oss-local-staging-required"
    });
  });

  test("falls back without streaming when remote name exists with a different size", async () => {
    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-conflict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      existingRemoteFile: { Name: "file.bin", Size: 42 }
    });

    expect(result).toMatchObject({ success: false, fallback: true, reason: "remote-name-conflict" });
    expect(cloudTool.createRcatStream).not.toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
  });

  test("does not delete final remote name when validation fails after moveto", async () => {
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: ".drive-collector-task-1-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin" });
    cloudTool.moveRemoteFile.mockResolvedValue({ success: true, fileName: "file.bin" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(null);

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-1", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({ success: false, fallback: true });
    expect(cloudTool.moveRemoteFile).toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalledWith("file.bin", "user-1");
  });

  test("cleans staging and completes when final file appears concurrently with same size", async () => {
    const proc = createProcess();
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-1-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "file.bin", Size: 11 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-1", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({ success: true, method: "remote_existing", fileName: "file.bin" });
    expect(cloudTool.moveRemoteFile).not.toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });
});
