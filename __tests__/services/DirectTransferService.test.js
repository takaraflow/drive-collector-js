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
const { RCLONE_ERROR_CODES } = await import("../../src/domain/rclone-error.js");

function createProcess({ exitCode = 0, signal = null, stderr = "" } = {}) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.complete = () => {
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode, signal);
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

function createStalledBackpressureWritable() {
  const writable = new EventEmitter();
  writable.writable = true;
  writable.destroyed = false;
  writable.closed = false;
  writable.write = vi.fn(() => false);
  writable.end = vi.fn();
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

  test("sweeps only expired orphan staging files, sparing live transfers and user files", async () => {
    const now = 1_700_000_000_000;
    const orphan = `.drive-collector-task-old-${now - 60 * 60 * 1000}-123e4567-e89b-12d3-a456-426614174000.part.movie.mkv`;
    const inFlight = `.drive-collector-task-live-${now - 60 * 1000}-223e4567-e89b-12d3-a456-426614174000.part.movie2.mkv`;
    cloudTool.listRemoteFiles = vi.fn().mockResolvedValue([
      { Name: orphan, Size: 800_000_000 },
      { Name: inFlight, Size: 400_000_000 },
      { Name: "user-own-video.mp4", Size: 1_000_000 },
      { Name: "folder", IsDir: true }
    ]);

    const result = await service.sweepOrphanStagingFiles({ userId: "user-1", now });

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledTimes(1);
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(orphan, "user-1");
  });

  test("orphan sweep survives an unlistable drive without throwing", async () => {
    cloudTool.listRemoteFiles = vi.fn().mockRejectedValue(new Error("drive not found"));

    await expect(service.sweepOrphanStagingFiles({ userId: "user-1" }))
      .resolves.toEqual({ deleted: 0, failed: 0 });
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
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

  test("protondrive streams straight to the final name and skips the server-side move", async () => {
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 11 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-proton", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "movie.mkv",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: true, method: "direct_stream", fileName: "movie.mkv" });
    // Proton 的 moveto 会因目录最终一致性稳定报 directory not found,直写整段跳过它
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith("movie.mkv", "user-1", { size: 11 });
    expect(cloudTool.moveRemoteFile).not.toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
  });

  test("never hands rclone an estimated photo size, and accepts whatever byte count it lands", async () => {
    // 线上真实故障:照片任务报
    //   "Failed to rcat: corrupted on transfer: sizes differ src 47379 vs dst 80482"
    // 且 attempts=1 —— classifyRcloneError 不认 "sizes differ",落到 UNKNOWN/retryable:false,
    // 一次就判死,连 5 次重试的资格都没有。
    // 真相是我们给的 --size 是估算值(见 getMediaInfo 的 sizeExact),rclone 实收 80482 反而是对的。
    // 照片走"不校验字节数"路径:--size 不传(0),传后验证不要求精确相等。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "photo.jpg" });
    // 网盘上的真实大小与我们报的 47379 对不上 —— 精确校验会把这判成损坏
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "photo.jpg", Size: 80482 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-photo-size", userId: "user-1" },
      message: { media: { photo: {} } },
      client,
      info: { size: 47379, sizeExact: false },
      fileName: "photo.jpg",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: true, method: "direct_stream", fileName: "photo.jpg" });
    // size 传 0 → rclone.js 不会 push --size,让它自己数 stdin
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith("photo.jpg", "user-1", { size: 0 });
    // 回报的字节数是网盘上的实测值,不是那个估算值
    expect(result.bytes).toBe(80482);
  });

  test("still hands rclone the exact size for documents and videos", async () => {
    // sizeExact 默认 true,document/video 的 obj.size 是服务端权威值,行为不能变。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 11 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-doc-size", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11, sizeExact: true },
      fileName: "movie.mkv",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: true, bytes: 11 });
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith("movie.mkv", "user-1", { size: 11 });
  });

  test("rejects a genuinely wrong byte count for a document", async () => {
    // 反例,证明上面不是把校验整个关掉:文档的 size 是权威值,对不上就是真出事。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 12 }); // 报 11,实收 12

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-doc-mismatch", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11, sizeExact: true },
      fileName: "movie.mkv",
      driveType: "protondrive"
    });

    expect(result.success).toBe(false);
  });

  test("never hands rclone an estimated photo size, and accepts whatever byte count it lands", async () => {
    // 线上真实故障:照片任务报
    //   "Failed to rcat: corrupted on transfer: sizes differ src 47379 vs dst 80482"
    // 且 attempts=1 —— classifyRcloneError 不认 "sizes differ",落到 UNKNOWN/retryable:false,
    // 一次就判死,连 5 次重试的资格都没有。
    // 真相是我们给的 --size 是估算值(见 getMediaInfo 的 sizeExact),rclone 实收 80482 反而是对的。
    // 照片走"不校验字节数"路径:--size 不传(0),传后验证不要求精确相等。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "photo.jpg" });
    // 网盘上的真实大小与我们报的 47379 对不上 —— 精确校验会把这判成损坏
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "photo.jpg", Size: 80482 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-photo-size", userId: "user-1" },
      message: { media: { photo: {} } },
      client,
      info: { size: 47379, sizeExact: false },
      fileName: "photo.jpg",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: true, method: "direct_stream", fileName: "photo.jpg" });
    // size 传 0 → rclone.js 不会 push --size,让它自己数 stdin
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith("photo.jpg", "user-1", { size: 0 });
    // 回报的字节数是网盘上的实测值,不是那个估算值
    expect(result.bytes).toBe(80482);
  });

  test("still hands rclone the exact size for documents and videos", async () => {
    // sizeExact 默认 true,document/video 的 obj.size 是服务端权威值,行为不能变。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 11 });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-doc-size", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11, sizeExact: true },
      fileName: "movie.mkv",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: true, bytes: 11 });
    expect(cloudTool.createRcatStream).toHaveBeenCalledWith("movie.mkv", "user-1", { size: 11 });
  });

  test("rejects a genuinely wrong byte count for a document", async () => {
    // 反例,证明上面不是把校验整个关掉:文档的 size 是权威值,对不上就是真出事。
    const proc = createProcess();
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "movie.mkv" });
    cloudTool.getRemoteFileInfo
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Name: "movie.mkv", Size: 12 }); // 报 11,实收 12

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-doc-mismatch", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11, sizeExact: true },
      fileName: "movie.mkv",
      driveType: "protondrive"
    });

    expect(result.success).toBe(false);
  });

  test("protondrive never deletes the final name when the direct write fails", async () => {
    const proc = createProcess({ exitCode: 1, stderr: "boom" });
    const stdin = createWritable(proc);
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: "file.bin" });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-proton-fail", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      driveType: "protondrive"
    });

    expect(result).toMatchObject({ success: false, fallback: true });
    // 最终名不是 _isManagedStagingFile 认的 staging 名,删它等于删用户文件
    expect(cloudTool.deleteRemoteFile).not.toHaveBeenCalled();
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

  test("retries retryable Telegram source failures up to maxAttempts before giving up", async () => {
    const stagingName = ".drive-collector-task-retry-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockImplementation(() => {
      const proc = createProcess();
      const stdin = createWritable(proc);
      return Promise.resolve({ stdin, proc, fileName: stagingName });
    });
    // 每次都抛可重试的 telegram 断连错误
    client.iterDownload.mockImplementation(() => (async function* () {
      throw new Error("400: CONNECTION_NOT_INITED (caused by upload.GetFile)");
    })());

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-retry", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          maxAttempts: 3,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({
      success: false,
      retryable: true,
      errorCode: "TELEGRAM_SOURCE_TRANSIENT",
      directTransferAttempts: 3
    });
    // maxAttempts=3 → 应尝试 3 次
    expect(client.iterDownload).toHaveBeenCalledTimes(3);
  });

  test("重试 telegram_source 失败前调用 resetSource(拆卡死下载 sender),成功后不再调", async () => {
    // 直接打桩重试循环的内层调用,精准验证「重试之间是否重置 sender」这条逻辑,
    // 不牵扯 rcat/iterDownload/校验等无关内部管线。
    const svc = new DirectTransferService();
    svc._delay = async () => {};
    let calls = 0;
    svc._transferTelegramMediaToRemoteOnce = async () => {
      calls += 1;
      return calls <= 2
        ? { success: false, retryable: true, retryScope: "telegram_source", errorCode: "TELEGRAM_SOURCE_TRANSIENT" }
        : { success: true };
    };

    const resetCalls = [];
    const res = await svc.transferTelegramMediaToRemote({
      task: { id: "t-reset" },
      config: { directTransfer: { resetSenderOnRetry: true, maxAttempts: 5, retryDelayMs: 0 } },
      resetSource: async () => { resetCalls.push(calls); }
    });

    expect(res.success).toBe(true);
    // 前两次失败后各重置一次,且都发生在下一次(最终成功的)尝试之前。
    expect(resetCalls).toEqual([1, 2]);
  });

  test("resetSenderOnRetry=false 时不调 resetSource(逃生开关)", async () => {
    const svc = new DirectTransferService();
    svc._delay = async () => {};
    svc._transferTelegramMediaToRemoteOnce = async () =>
      ({ success: false, retryable: true, retryScope: "telegram_source", errorCode: "TELEGRAM_SOURCE_TRANSIENT" });

    let resetCount = 0;
    await svc.transferTelegramMediaToRemote({
      task: { id: "t-noreset" },
      config: { directTransfer: { resetSenderOnRetry: false, maxAttempts: 3, retryDelayMs: 0 } },
      resetSource: async () => { resetCount += 1; }
    });

    expect(resetCount).toBe(0);
  });

  test("rclone_target 可重试失败不触发 resetSource(不误拆 TG 下载 sender)", async () => {
    const svc = new DirectTransferService();
    svc._delay = async () => {};
    svc._transferTelegramMediaToRemoteOnce = async () =>
      ({ success: false, retryable: true, retryScope: "rclone_target", errorCode: "RCLONE_TRANSIENT" });

    let resetCount = 0;
    const res = await svc.transferTelegramMediaToRemote({
      task: { id: "t-rclone" },
      config: { directTransfer: { resetSenderOnRetry: true, maxAttempts: 2, retryDelayMs: 0 } },
      resetSource: async () => { resetCount += 1; }
    });

    expect(res.retryScope).not.toBe("telegram_source");
    expect(resetCount).toBe(0);
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
      userRetryable: true,
      retryScope: "rclone_target"
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

  test("treats rclone signal termination as retryable in strict zero-disk mode", async () => {
    const proc = createProcess({ exitCode: null, signal: "SIGTERM" });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-signal-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      yield Buffer.from("hello");
    })());

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-signal", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
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
      error: "rclone rcat terminated by signal SIGTERM",
      errorCode: "RCLONE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "rclone_target"
    });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("preserves rclone process exit metadata when stderr is present", async () => {
    const proc = createProcess({
      exitCode: null,
      signal: "SIGTERM",
      stderr: "INFO : backend emitted diagnostic before shutdown"
    });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-null-exit-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      yield Buffer.from("hello");
    })());

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-null-exit", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
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
      error: "rclone rcat terminated by signal SIGTERM; INFO : backend emitted diagnostic before shutdown",
      errorCode: "RCLONE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "rclone_target"
    });
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("fails strict zero-disk transfer when Telegram source makes no progress", async () => {
    vi.useFakeTimers();
    const proc = createProcess();
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-source-stall-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const sourceIterator = {
      next: vi.fn(() => new Promise(() => {})),
      return: vi.fn(async () => ({ done: true }))
    };
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue(sourceIterator);

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-source-stall", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 10000,
          stallTimeoutMs: 100,
          minStallTimeoutMs: 0,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1600);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "TELEGRAM_SOURCE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "telegram_source"
    });
    expect(result.error).toContain("direct transfer stall timeout");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(sourceIterator.return).toHaveBeenCalled();
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("treats a 0-byte Telegram source as a retryable telegram_source failure, not an rclone error", async () => {
    // gramjs 的 _downloadPhoto / 未知 media 分支都是 `return Buffer.alloc(0)`,不抛错。
    // 照片解析失败时 iterDownload 因此"成功"地产出空流;喂给 rclone 会被报成
    // "sizes differ src 0" —— 既误导(rclone 背锅)又跳过重试(源侧真凶被掩盖)。
    vi.useFakeTimers();
    const proc = createProcess();
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-empty-1-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const sourceIterator = {
      next: vi.fn(async () => ({ done: true })), // 一个字节都没有
      return: vi.fn(async () => ({ done: true }))
    };
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue(sourceIterator);

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-empty-source", userId: "user-1" },
      message: { media: { photo: {} } },
      client,
      info: { size: 80482 },
      fileName: "photo.jpg",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 10000,
          stallTimeoutMs: 100,
          minStallTimeoutMs: 0,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1600);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "TELEGRAM_SOURCE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "telegram_source"
    });
    expect(result.error).toContain("empty stream");
    expect(result.error).toContain("80482");
    // 空流绝不能 end stdin 让 rclone 自顾自跑完 —— 必须主动收掉
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(sourceIterator.return).toHaveBeenCalled();
  });

  test("keeps telegram_source scope when the stall hook SIGTERMs rclone", async () => {
    vi.useFakeTimers();
    const proc = createProcess();
    // 真实 OS 语义:我们的 stall 钩子 SIGTERM 掉 rclone,rclone 随后以 (null, SIGTERM) 关闭,
    // 于是 _watchRcloneProcess 报 "terminated by signal SIGTERM" —— 这条死信号不能盖掉源侧定性。
    proc.kill = vi.fn(() => proc.emit("close", null, "SIGTERM"));
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-source-sigterm-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const sourceIterator = {
      next: vi.fn(() => new Promise(() => {})),
      return: vi.fn(async () => ({ done: true }))
    };
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue(sourceIterator);

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-source-sigterm", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 10000,
          stallTimeoutMs: 100,
          minStallTimeoutMs: 0,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1600);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "TELEGRAM_SOURCE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "telegram_source"
    });
    expect(result.error).toContain("direct transfer stall timeout");
    expect(result.error).toContain("terminated by signal SIGTERM");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
  });

  test("keeps rclone_target when the stalled run also produced its own rclone diagnostic", async () => {
    vi.useFakeTimers();
    const proc = createProcess({ exitCode: null, signal: "SIGTERM", stderr: "ERROR : 存储空间超限 (Code=200002)" });
    proc.kill = vi.fn(() => proc.complete());
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-src-diag-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    const sourceIterator = {
      next: vi.fn(() => new Promise(() => {})),
      return: vi.fn(async () => ({ done: true }))
    };
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue(sourceIterator);

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-src-diag", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 10000,
          stallTimeoutMs: 100,
          minStallTimeoutMs: 0,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1600);
    const result = await resultPromise;

    // rclone 带上了自己的诊断 → 那是另一个独立的、可能是永久性的网盘故障,定性归它,
    // 不能因为源侧也恰好 stall 了就一律盖成可重试的 TELEGRAM_SOURCE_TRANSIENT。
    expect(result.retryScope).toBe("rclone_target");
    expect(result.errorCode).not.toBe("TELEGRAM_SOURCE_TRANSIENT");
    expect(result.error).toContain("存储空间超限");
    // 源侧原因仍然留在 message 里,不丢证据
    expect(result.error).toContain("direct transfer stall timeout");
  });

  test("fails strict zero-disk transfer when rclone stdin backpressure stalls", async () => {
    vi.useFakeTimers();
    const proc = createProcess();
    const stdin = createStalledBackpressureWritable();
    const stagingName = ".drive-collector-task-write-stall-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });
    client.iterDownload.mockReturnValue((async function* () {
      yield Buffer.from("hello");
    })());

    const resultPromise = service.transferTelegramMediaToRemote({
      task: { id: "task-write-stall", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 5 },
      fileName: "file.bin",
      config: {
        directTransfer: {
          enabled: true,
          fallbackToLocal: false,
          timeoutMs: 10000,
          stallTimeoutMs: 100,
          minStallTimeoutMs: 0,
          maxAttempts: 1,
          retryDelayMs: 0
        },
        remoteName: "mega",
        oss: {}
      }
    });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(1600);
    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: "RCLONE_TRANSIENT",
      retryable: true,
      userRetryable: true,
      retryScope: "rclone_target"
    });
    expect(result.error).toContain("rclone_stdin");
    expect(stdin.destroy).toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
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

  test("retries retryable Telegram source timeouts before falling back", async () => {
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

  test("classifies rclone over-quota stderr as a drive quota failure", async () => {
    const quotaStderr = `{"time":"2026-05-21T17:49:45.876097777Z","level":"notice","msg":"Failed to rcat with 2 errors: last error was: upload file failed to create session: [REDACTED] over quota","source":"slog/logger.go:256"}`;
    const proc = createProcess({ exitCode: 1, stderr: quotaStderr });
    const stdin = createWritable(proc);
    const stagingName = ".drive-collector-task-quota-123-123e4567-e89b-12d3-a456-426614174000.part.file.bin";
    cloudTool.createRcatStream.mockResolvedValue({ stdin, proc, fileName: stagingName });

    const result = await service.transferTelegramMediaToRemote({
      task: { id: "task-quota", userId: "user-1" },
      message: { media: { document: {} } },
      client,
      info: { size: 11 },
      fileName: "file.bin",
      config: {
        directTransfer: { enabled: true, fallbackToLocal: false },
        remoteName: "mega",
        oss: {}
      }
    });

    expect(result).toMatchObject({
      success: false,
      fallback: false,
      errorCode: RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
      retryable: false,
      userRetryable: true
    });
    expect(result.userMessage).toBe("目标网盘空间不足。请清理空间或更换保存目录后再重试。");
    expect(cloudTool.deleteRemoteFile).toHaveBeenCalledWith(stagingName, "user-1");
    expect(loggerFns.warn).toHaveBeenCalledWith(
      "Direct transfer failed closed",
      expect.objectContaining({
        taskId: "task-quota",
        errorCode: RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
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

describe("TransferSpeedMonitor", () => {
  let TransferSpeedMonitor;

  beforeAll(async () => {
    const mod = await import("../../src/services/DirectTransferService.js");
    TransferSpeedMonitor = mod.TransferSpeedMonitor;
  });

  test("returns null speed with fewer than 2 samples", () => {
    const monitor = new TransferSpeedMonitor();
    expect(monitor.getBytesPerSecond()).toBeNull();
    monitor.record(1024);
    expect(monitor.getBytesPerSecond()).toBeNull();
  });

  test("calculates bytes per second from samples", () => {
    vi.useFakeTimers();
    const monitor = new TransferSpeedMonitor({ windowMs: 60000 });
    monitor.record(1000);
    vi.advanceTimersByTime(1000);
    monitor.record(1000);
    const speed = monitor.getBytesPerSecond();
    expect(speed).toBeGreaterThan(0);
    expect(speed).toBeCloseTo(1000, -2);
    vi.useRealTimers();
  });

  test("uses adaptive min timeout during warmup", () => {
    const monitor = new TransferSpeedMonitor();
    monitor.record(100);
    const timeout = monitor.getAdaptiveStallTimeoutMs(512 * 1024, 180000);
    expect(timeout).toBeGreaterThanOrEqual(90000);
  });

  test("uses base timeout when it exceeds adaptive min during warmup", () => {
    const monitor = new TransferSpeedMonitor();
    monitor.record(100);
    const timeout = monitor.getAdaptiveStallTimeoutMs(512 * 1024, 300000);
    expect(timeout).toBe(300000);
  });

  test("respects custom minTimeoutMs parameter", () => {
    const monitor = new TransferSpeedMonitor();
    monitor.record(100);
    const timeout = monitor.getAdaptiveStallTimeoutMs(512 * 1024, 100, { minTimeoutMs: 0 });
    expect(timeout).toBe(100);
  });

  test("computes adaptive timeout from speed after warmup", () => {
    vi.useFakeTimers();
    const monitor = new TransferSpeedMonitor({ windowMs: 60000 });
    const chunkSize = 512 * 1024;
    for (let i = 0; i < 10; i++) {
      monitor.record(chunkSize);
      vi.advanceTimersByTime(100);
    }
    const timeout = monitor.getAdaptiveStallTimeoutMs(chunkSize, 180000, { minTimeoutMs: 0 });
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(30 * 60 * 1000);
    vi.useRealTimers();
  });

  test("caps adaptive timeout at maximum", () => {
    vi.useFakeTimers();
    const monitor = new TransferSpeedMonitor({ windowMs: 60000 });
    for (let i = 0; i < 5; i++) {
      monitor.record(1);
      vi.advanceTimersByTime(100);
    }
    const timeout = monitor.getAdaptiveStallTimeoutMs(512 * 1024, 180000, { minTimeoutMs: 0 });
    expect(timeout).toBeLessThanOrEqual(30 * 60 * 1000);
    vi.useRealTimers();
  });

  test("tracks total bytes and elapsed time", () => {
    vi.useFakeTimers();
    const monitor = new TransferSpeedMonitor();
    monitor.record(1000);
    vi.advanceTimersByTime(500);
    monitor.record(2000);
    expect(monitor.getTotalBytes()).toBe(3000);
    expect(monitor.getElapsedMs()).toBeGreaterThanOrEqual(500);
    vi.useRealTimers();
  });
});
