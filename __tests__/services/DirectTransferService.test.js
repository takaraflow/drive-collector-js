import { EventEmitter } from "events";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

const loggerFns = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}));

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
    withModule: () => loggerFns
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

function createEpipeWritable(proc) {
  const writable = new EventEmitter();
  writable.writable = true;
  writable.destroyed = false;
  writable.closed = false;
  writable.write = vi.fn(() => {
    queueMicrotask(() => proc?.complete?.());
    const error = new Error("write EPIPE");
    error.code = "EPIPE";
    throw error;
  });
  writable.end = vi.fn();
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
    vi.useRealTimers();
    loggerFns.warn.mockClear();
    loggerFns.info.mockClear();
    loggerFns.error.mockClear();
    loggerFns.debug.mockClear();
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

  afterEach(() => {
    vi.useRealTimers();
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
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith(
      expect.stringMatching(/^\.drive-collector-task-1-/),
      "user-1",
      { size: 11 }
    );
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

  test("keeps Telegram source connection failures retryable without local fallback", async () => {
    const proc = createProcess();
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-source-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      throw new Error("400: CONNECTION_NOT_INITED (caused by upload.GetFile)");
    })());

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-source", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: true,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "TELEGRAM_SOURCE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "telegram_source"
    });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("redacts sensitive rclone stderr before returning fallback errors", async () => {
    const proc = createProcess({
      exitCode: 1,
      stderr: `CRITICAL: Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": couldn't login`
    });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-redact-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-redact", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({ success: false, fallback: false });
    expect(result.error).toContain('user="[REDACTED]"');
    expect(result.error).toContain('pass="[REDACTED]"');
    expect(result.error).not.toContain('user@example.com');
    expect(result.error).not.toContain('secret-pass');
  });

  test("returns remote-not-found metadata for permanent MEGA node failures", async () => {
    const proc = createProcess({
      exitCode: 1,
      stderr: `CRITICAL | Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": couldn't login: Object (typically, node or user) not found`
    });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-auth-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-auth", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "DRIVE_REMOTE_NOT_FOUND",
      retryable: false,
      userRetryable: true
    });
    expect(result.userMessage).toContain("保存目录");
    expect(result.error).not.toContain("user@example.com");
    expect(result.error).not.toContain("secret-pass");
  });

  test("uses rcat context when sanitized diagnostics lose remote path", async () => {
    const proc = createProcess({
      exitCode: 1,
      stderr: `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`
    });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-auth-ctx-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-auth-ctx", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "DRIVE_REMOTE_NOT_FOUND",
      userRetryable: true
    });
    expect(result.userMessage).toContain("保存目录");
  });

  test("prefers current rclone diagnostics over stale rclone failure metadata", async () => {
    const staleFailure = {
      success: false,
      error: `CRITICAL | Failed to create file system for ":mega,user=\\"[REDACTED]": couldn't login: Object (typically, node or user) not found`,
      errorCode: "DRIVE_AUTH_INVALID",
      userMessage: "当前绑定的网盘无法登录。请重新绑定网盘后再重试。",
      retryable: false,
      userRetryable: false
    };
    cloudTool.createRcatStream.mockRejectedValue(staleFailure);

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-stale", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "DRIVE_REMOTE_NOT_FOUND",
      userRetryable: true
    });
    expect(result.userMessage).toContain("保存目录");
    expect(result.userMessage).not.toContain("无法登录");
  });

  test("uses rclone stderr instead of EPIPE when rcat exits during streaming", async () => {
    const proc = createProcess({
      exitCode: 1,
      stderr: `CRITICAL | Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": couldn't login: Object (typically, node or user) not found`
    });
    const stdin = createEpipeWritable(proc);
    const stagingName = ".drive-collector-task-epipe-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-epipe", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin"
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "DRIVE_REMOTE_NOT_FOUND",
      retryable: false,
      userRetryable: true
    });
    expect(result.error).toContain('user="[REDACTED]"');
    expect(result.error).not.toContain("write EPIPE");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("times out a stuck rcat process and falls back to local staging", async () => {
    vi.useFakeTimers();
    const proc = createProcess();
    const stdin = createWritable();
    const stagingName = ".drive-collector-task-timeout-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      yield Buffer.from("hello");
    })());

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-timeout", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: true,
          timeoutMs: 100,
          maxAttempts: 1,
          retryDelayMs: 0
        }
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ success: false, fallback: true });
    expect(result).toMatchObject({
      errorCode: "RCLONE_TRANSIENT",
      retryable: true,
      userRetryable: true
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("keeps transient timeout metadata but disallows local fallback in strict zero-disk mode", async () => {
    vi.useFakeTimers();
    const proc = createProcess();
    const stdin = createWritable();
    const stagingName = ".drive-collector-task-timeout-strict-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      yield Buffer.from("hello");
    })());

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-timeout-strict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 100,
          maxAttempts: 1,
          retryDelayMs: 0
        }
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "RCLONE_TRANSIENT",
      retryable: true,
      userRetryable: true
    });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
    expect(loggerFns.warn).toHaveBeenCalledWith(
      "Direct transfer failed closed",
      expect.objectContaining({
        taskId: "task-timeout-strict",
        userId: "user-1",
        fileName: "file.bin",
        errorCode: "RCLONE_TRANSIENT",
        retryable: true,
        userRetryable: true,
        fallbackAllowed: false
      })
    );
  });

  test("fails closed by default when fallback is not explicitly enabled", async () => {
    const proc = createProcess({ exitCode: 1, stderr: "i/o timeout" });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-default-strict-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-default-strict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      config: {
        directTransfer: { enabled: true },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false
    });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
    expect(loggerFns.warn).toHaveBeenCalledWith(
      "Direct transfer failed closed",
      expect.objectContaining({
        taskId: "task-default-strict",
        fallbackAllowed: false
      })
    );
  });

  test("retries retryable direct transfer timeouts before falling back", async () => {
    const firstProc = createProcess();
    const secondProc = createProcess();
    const firstStaging = ".drive-collector-task-retry-1-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const secondStaging = ".drive-collector-task-retry-2-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const firstStdIn = createWritable(firstProc);
    const secondStdIn = createWritable(secondProc);
    let remoteCalls = 0;

    cloudTool.createRcatStream
      .mockResolvedValueOnce({ stdin: firstStdIn, proc: firstProc, fileName: firstStaging })
      .mockResolvedValueOnce({ stdin: secondStdIn, proc: secondProc, fileName: secondStaging });
    cloudTool.moveRemoteFile.mockResolvedValue({ success: true, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo.mockImplementation(async () => {
      remoteCalls += 1;
      return remoteCalls >= 4 ? { Name: "movie.mkv", Size: 11 } : null;
    });
    client.iterDownload
      .mockImplementationOnce(() => (async function* () {
        yield Buffer.from("hello");
        throw new Error("TIMEOUT");
      })())
      .mockImplementationOnce(() => (async function* () {
        yield Buffer.from("hello ");
        yield Buffer.from("world");
      })());

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-retry", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "movie.mkv",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: true,
          timeoutMs: 1000,
          maxAttempts: 2,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({
      success: true,
      method: "direct_stream",
      fileName: "movie.mkv",
      bytes: 11
    });
    expect(cloudTool.createRcatStream).toHaveBeenCalledTimes(2);
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(firstStaging, "user-1");
    expect(cloudTool.moveRemoteFile).toHaveBeenCalledWith(secondStaging, "movie.mkv", "user-1");
    expect(loggerFns.info).toHaveBeenCalledWith(
      "Retrying direct transfer after retryable failure",
      expect.objectContaining({
        taskId: "task-retry",
        userId: "user-1",
        fileName: "movie.mkv",
        attempt: 1,
        maxAttempts: 2
      })
    );
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

  test("does not allow local fallback for remote name conflicts in strict zero-disk mode", async () => {
    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-conflict-strict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      existingRemoteFile: { Name: "file.bin", Size: 42 },
      config: {
        directTransfer: { enabled: true, fallbackToLocal: false },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({ success: false, fallback: false, reason: "remote-name-conflict" });
    expect(cloudTool.createRcatStream).not.toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
  });

  test("does not allow local fallback for unsupported targets in strict zero-disk mode", async () => {
    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-oss-strict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      driveType: "oss",
      config: {
        directTransfer: { enabled: true, fallbackToLocal: false },
        remoteName: "oss",
        oss: {}
      }
    });

    expect(result).toMatchObject({ success: false, fallback: false, reason: "oss-local-staging-required" });
    expect(cloudTool.createRcatStream).not.toHaveBeenCalled();
  });

  test("treats string false fallback config as strict zero-disk mode", async () => {
    const proc = createProcess({ exitCode: 1, stderr: "backend timeout" });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-string-strict-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-string-strict", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      config: {
        directTransfer: { enabled: "TRUE", fallbackToLocal: "FALSE" },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({ success: false, fallback: false });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
    expect(loggerFns.warn).toHaveBeenCalledWith(
      "Direct transfer failed closed",
      expect.objectContaining({
        taskId: "task-string-strict",
        fallbackAllowed: false
      })
    );
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
