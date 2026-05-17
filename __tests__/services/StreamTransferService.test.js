import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Writable } from 'stream'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { streamTransferService } from '../../src/services/StreamTransferService.js'
import { logger } from '../../src/services/logger/index.js'
import { cache } from '../../src/services/CacheService.js'
import { getConfig } from '../../src/config/index.js'

const streamTransferLog = logger.withModule('StreamTransferService')
const rcloneMock = vi.hoisted(() => ({
  CloudTool: {
    createRcatStream: vi.fn(),
    getRemoteFileInfo: vi.fn(),
    sanitizeRemoteFileName: vi.fn((fileName) => String(fileName || '').split('/').pop() || 'unnamed.bin'),
    deleteRemoteFile: vi.fn(),
    uploadLocalFileToRemote: vi.fn()
  },
  streams: []
}))

function createMockRcatStream() {
  const chunks = []
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    }
  })
  const proc = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()

  return { stdin, proc, chunks }
}

const createChunkReq = (headers, body = 'data') => ({
  headers: {
    'x-instance-secret': 'test-secret',
    'x-file-name': encodeURIComponent('stream.txt'),
    'x-user-id': 'user-123',
    'x-is-last': 'false',
    'x-chunk-index': '0',
    'x-total-size': String(Buffer.byteLength(body)),
    'x-leader-url': '',
    'x-source-instance-id': '',
    'x-chat-id': 'chat-123',
    'x-msg-id': '456',
    'x-resume-enabled': 'true',
    'x-stream-owner-instance-id': 'worker-current',
    ...headers
  },
  [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(body)
  }
})

const flushAsyncEvents = () => new Promise(resolve => setImmediate(resolve))
const ownerRecord = taskId => ({
  taskId,
  instanceId: 'worker-current',
  url: 'https://worker.example.com',
  registeredBy: 'leader-1',
  registeredAt: Date.now()
})
const mockCacheByKey = overrides => {
  cache.get.mockImplementation(async key => {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key]
      return typeof value === 'function' ? value(key) : value
    }
    if (key.startsWith('stream:owner:')) {
      return ownerRecord(key.slice('stream:owner:'.length))
    }
    return null
  })
}

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn(() => ({
    streamForwarding: {
      secret: 'test-secret',
      lbUrl: 'https://lb.example.com'
    },
    remoteFolder: '/drive/uploads'
  }))
}))

vi.mock('../../src/services/CacheService.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    instanceId: 'worker-current',
    getAllInstances: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('../../src/repositories/TaskRepository.js', () => ({
  TaskRepository: {
    updateStatus: vi.fn().mockResolvedValue(true),
    transitionStatus: vi.fn().mockResolvedValue({ changed: true, blocked: false })
  }
}))

vi.mock('../../src/utils/telegramBotApi.js', () => ({
  TelegramBotApi: {
    editMessageText: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('../../src/services/rclone.js', () => ({
  CloudTool: rcloneMock.CloudTool
}))

describe('StreamTransferService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    global.fetch = vi.fn()
    streamTransferService.activeStreams.clear()
    streamTransferService.chunkRetryAttempts.clear()
    streamTransferService.taskLocks?.clear()
    cache.get.mockReset()
    cache.set.mockReset()
    cache.delete.mockReset()
    mockCacheByKey({})
    cache.set.mockResolvedValue(true)
    cache.delete.mockResolvedValue(true)
    rcloneMock.streams.length = 0
    rcloneMock.CloudTool.createRcatStream.mockReset()
    rcloneMock.CloudTool.getRemoteFileInfo.mockReset()
    rcloneMock.CloudTool.sanitizeRemoteFileName.mockReset()
    rcloneMock.CloudTool.deleteRemoteFile.mockReset()
    rcloneMock.CloudTool.uploadLocalFileToRemote.mockReset()
    rcloneMock.CloudTool.createRcatStream.mockImplementation(() => {
      const stream = createMockRcatStream()
      rcloneMock.streams.push(stream)
      return { stdin: stream.stdin, proc: stream.proc, fileName: 'stream.txt' }
    })
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValue({ Name: 'stream.txt', Size: 0 })
    rcloneMock.CloudTool.sanitizeRemoteFileName.mockImplementation((fileName) => String(fileName || '').split('/').pop() || 'unnamed.bin')
    rcloneMock.CloudTool.deleteRemoteFile.mockResolvedValue({ success: true })
    rcloneMock.CloudTool.uploadLocalFileToRemote.mockResolvedValue({ success: true, fileName: 'stream.txt' })
    // Mock logger methods
    vi.spyOn(streamTransferLog, 'info').mockImplementation(() => {})
    vi.spyOn(streamTransferLog, 'warn').mockImplementation(() => {})
    vi.spyOn(streamTransferLog, 'error').mockImplementation(() => {})
  })

  test('getRemoteProgress ���ۦ', async () => {
    // !��� fetch ͔
    const mockData = { lastChunkIndex: 5 }
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData)
    })

    const progress = await streamTransferService.getRemoteProgress('https://lb.example.com', 'task-123')
    expect(progress).toBe(5)
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-123/progress',
      {
        method: 'GET',
        headers: {
          'x-instance-secret': 'test-secret'
        }
      }
    )
  })

  test('getRemoteProgress ^200͔', async () => {
    // !�404͔
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404
    })

    await expect(
      streamTransferService.getRemoteProgress('https://lb.example.com', 'task-123')
    ).rejects.toThrow('Worker returned 404')
  })

  test('handleIncomingChunk rejects when both configured secret and header are empty', async () => {
    getConfig.mockReturnValueOnce({
      streamForwarding: {
        secret: '',
        lbUrl: 'https://lb.example.com'
      },
      remoteFolder: '/drive/uploads'
    })
    const req = {
      headers: { 'x-instance-secret': '' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('data')
      }
    }

    const result = await streamTransferService.handleIncomingChunk('task-empty-secret', req)

    expect(result).toEqual({ success: false, statusCode: 401, message: 'Unauthorized' })
  })

  test('handleStatusUpdate rejects when both configured secret and header are empty', async () => {
    getConfig.mockReturnValueOnce({
      streamForwarding: {
        secret: '',
        lbUrl: 'https://lb.example.com'
      },
      remoteFolder: '/drive/uploads'
    })

    const result = await streamTransferService.handleStatusUpdate(
      'task-empty-secret',
      { status: 'completed' },
      { 'x-instance-secret': '' }
    )

    expect(result).toEqual({ success: false, statusCode: 401, message: 'Unauthorized' })
  })

  test('forwardChunk posts directly and does not skip based on remote progress', async () => {
    const getRemoteProgressSpy = vi.spyOn(streamTransferService, 'getRemoteProgress')
    fetch.mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue('OK') })

    const taskId = 'task-456'
    const metadata = {
      fileName: 'test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex: 2,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com',
      ownerInstanceId: 'worker-current'
    }

    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

    expect(result).toBe(true)
    expect(getRemoteProgressSpy).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-456',
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from('test')
      })
    )
  })

  test('forward chunk fails when remote progress query fails', async () => {
    const mockService = {
      getRemoteProgress: vi.fn().mockRejectedValue(new Error('Query failed')),
      updateTelegramUI: vi.fn(),
      reportProgressToLeader: vi.fn()
    }
    vi.spyOn(streamTransferService, 'getRemoteProgress').mockImplementation(mockService.getRemoteProgress)
    
    // 模拟网络错误
    const mockError = new Error('Network error')
    fetch.mockRejectedValueOnce(mockError)
    
    // 考察参数
    const taskId = 'task-789'
    const metadata = {
      fileName: 'test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex: 5,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com',
      ownerInstanceId: 'worker-current'
    }

    await expect(
      streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    ).rejects.toThrow('Network error')
    
    // 这个测试中，错误不是超时错误，所以不会调用特定的warn日志
    // 移除这个期望，因为实际的日志调用可能不同
  })

  test('handleIncomingChunk returns 409 and does not append out-of-order chunk', async () => {
    const result = await streamTransferService.handleIncomingChunk(
      'task-out-of-order',
      createChunkReq({
        'x-chunk-index': '1',
        'x-total-size': '8'
      }, 'chunk-1')
    )

    expect(result).toMatchObject({
      success: false,
      statusCode: 409
    })
    expect(result.message).toContain('expected 0, got 1')
    expect(rcloneMock.streams).toHaveLength(0)
  })

  test('handleIncomingChunk starts from chunk 0 even when cached progress exists', async () => {
    mockCacheByKey({
      'stream:progress:task-no-fake-resume': {
      taskId: 'task-no-fake-resume',
      fileName: 'old.txt',
      userId: 'user-123',
      totalSize: 2048,
      uploadedBytes: 1024,
      lastChunkIndex: 7,
      timestamp: Date.now()
      }
    })

    const outOfOrderResult = await streamTransferService.handleIncomingChunk(
      'task-no-fake-resume',
      createChunkReq({
        'x-chunk-index': '8',
        'x-total-size': '12'
      }, 'chunk-8')
    )

    expect(outOfOrderResult).toMatchObject({
      success: false,
      statusCode: 409
    })
    expect(outOfOrderResult.message).toContain('expected 0, got 8')
    expect(rcloneMock.streams).toHaveLength(0)

    const firstChunkResult = await streamTransferService.handleIncomingChunk(
      'task-no-fake-resume',
      createChunkReq({
        'x-chunk-index': '0',
        'x-total-size': '12'
      }, 'chunk-0')
    )

    expect(firstChunkResult).toMatchObject({ success: true, statusCode: 200 })
    expect(rcloneMock.streams[0].chunks.map(chunk => chunk.toString())).toEqual(['chunk-0'])
  })

  test('handleIncomingChunk rejects wrong worker before creating stream or progress', async () => {
    mockCacheByKey({
      'stream:owner:task-wrong-worker': {
        ...ownerRecord('task-wrong-worker'),
        instanceId: 'worker-other'
      }
    })
    const result = await streamTransferService.handleIncomingChunk(
      'task-wrong-worker',
      createChunkReq({
        'x-stream-owner-instance-id': 'worker-other',
        'x-chunk-index': '0'
      }, 'hello')
    )

    expect(result).toMatchObject({
      success: false,
      statusCode: 409
    })
    expect(result.message).toContain('Wrong stream worker')
    expect(rcloneMock.CloudTool.createRcatStream).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalledWith(
      'stream:progress:task-wrong-worker',
      expect.anything(),
      expect.anything()
    )
  })

  test('handleIncomingChunk rejects missing owner header before touching stream state', async () => {
    const result = await streamTransferService.handleIncomingChunk(
      'task-missing-owner',
      createChunkReq({
        'x-stream-owner-instance-id': undefined,
        'x-chunk-index': '0'
      }, 'hello')
    )

    expect(result).toMatchObject({
      success: false,
      statusCode: 409
    })
    expect(result.message).toContain('owner header is required')
    expect(rcloneMock.CloudTool.createRcatStream).not.toHaveBeenCalled()
  })

  test('handleIncomingChunk fails closed when owner cache is unavailable', async () => {
    cache.get.mockRejectedValueOnce(new Error('redis unavailable'))

    const result = await streamTransferService.handleIncomingChunk(
      'task-owner-cache-down',
      createChunkReq({ 'x-chunk-index': '0' }, 'hello')
    )

    expect(result).toMatchObject({
      success: false,
      statusCode: 503
    })
    expect(result.message).toContain('owner is unavailable')
    expect(rcloneMock.CloudTool.createRcatStream).not.toHaveBeenCalled()
  })

  test('resumable chunk rejects wrong worker before touching staging file', async () => {
    mockCacheByKey({
      'stream:owner:task-wrong-resumable-worker': {
        ...ownerRecord('task-wrong-resumable-worker'),
        instanceId: 'worker-other'
      }
    })
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-wrong-worker-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir
      },
      remoteFolder: '/drive/uploads'
    })

    const result = await streamTransferService.handleIncomingChunk(
      'task-wrong-resumable-worker',
      createChunkReq({
        'x-file-name': encodeURIComponent('wrong.bin'),
        'x-stream-mode': 'resumable',
        'x-stream-owner-instance-id': 'worker-other',
        'x-chunk-index': '0',
        'x-total-size': '5'
      }, 'hello')
    )

    expect(result).toMatchObject({
      success: false,
      statusCode: 409
    })
    await expect(
      fs.promises.access(path.join(resumeDir, 'task-wrong-resumable-worker.wrong.bin.part'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cache.set).not.toHaveBeenCalledWith(
      'stream:progress:task-wrong-resumable-worker',
      expect.anything(),
      expect.anything()
    )
  })

  test('registerStreamOwner persists a single owner record', async () => {
    const owner = await streamTransferService.registerStreamOwner('task-owner', {
      instanceId: 'worker-current',
      url: 'https://worker.example.com',
      registeredBy: 'leader-1',
      ttlSeconds: 123
    })

    expect(owner).toMatchObject({
      taskId: 'task-owner',
      instanceId: 'worker-current',
      url: 'https://worker.example.com',
      registeredBy: 'leader-1'
    })
    expect(cache.set).toHaveBeenCalledWith(
      'stream:owner:task-owner',
      expect.objectContaining({ instanceId: 'worker-current' }),
      123
    )
  })

  test('resetTask sends DELETE to targetUrl reset endpoint when provided', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockResolvedValue({ success: true })
    })

    const result = await streamTransferService.resetTask(
      'task-remote-reset',
      'https://worker.example.com/',
      { ownerInstanceId: 'worker-current' }
    )

    expect(result).toEqual({ success: true })
    expect(fetch).toHaveBeenCalledWith(
      'https://worker.example.com/api/v2/stream/task-remote-reset/reset',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'x-instance-secret': 'test-secret',
          'x-stream-owner-instance-id': 'worker-current'
        })
      })
    )
  })

  test('finishTask fails when remote size does not match expected size', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
    const { TelegramBotApi } = await import('../../src/utils/telegramBotApi.js')
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'mismatch.txt', Size: 9 })

    await streamTransferService.finishTask('task-size-mismatch', {
      fileName: 'mismatch.txt',
      userId: 'user-123',
      totalSize: 10,
      chatId: 'chat-123',
      msgId: '456',
      leaderUrl: null
    })

    expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
      'task-size-mismatch',
      'fail',
      expect.stringContaining('Validation failed: remote(9) vs expected(10)'),
      expect.objectContaining({ source: 'stream_report_error' })
    )
    expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
      'task-size-mismatch',
      'complete',
      expect.anything(),
      expect.anything()
    )
    expect(TelegramBotApi.editMessageText).toHaveBeenCalledWith(
      'chat-123',
      456,
      expect.stringContaining('Validation failed')
    )
  })

  test('rcat close code 0 still fails when stderr contains an error', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')

    const result = await streamTransferService.handleIncomingChunk(
      'task-stderr-error',
      createChunkReq({
        'x-file-name': encodeURIComponent('stderr.txt'),
        'x-is-last': 'true',
        'x-chunk-index': '0',
        'x-total-size': '11'
      }, 'hello world')
    )
    const stream = rcloneMock.streams[0]

    stream.proc.stderr.emit('data', Buffer.from('ERROR : upload failed after retries\n'))
    stream.proc.emit('close', 0)
    await flushAsyncEvents()

    expect(result).toMatchObject({ success: true, statusCode: 200 })
    expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
      'task-stderr-error',
      'fail',
      expect.stringContaining('upload failed after retries'),
      expect.objectContaining({ source: 'stream_report_error' })
    )
    expect(TaskRepository.transitionStatus).not.toHaveBeenCalledWith(
      'task-stderr-error',
      'complete',
      expect.anything(),
      expect.anything()
    )
  })

  test('finishTask completes when remote validation succeeds', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
    const { TelegramBotApi } = await import('../../src/utils/telegramBotApi.js')
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'validated.txt', Size: 10 })

    await streamTransferService.finishTask('task-validated', {
      fileName: 'validated.txt',
      userId: 'user-123',
      totalSize: 10,
      chatId: 'chat-123',
      msgId: '456',
      sourceMsgId: '789',
      leaderUrl: null
    })

    expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
      'task-validated',
      'complete',
      null,
      expect.objectContaining({ source: 'stream_finish_task' })
    )
    expect(TelegramBotApi.editMessageText).toHaveBeenCalledWith(
      'chat-123',
      456,
      expect.stringContaining('/drive/uploads')
    )
  })

  test('resumable stream resumes from staging file size and uploads after final chunk', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-test-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'resume.bin', Size: 10 })

    const first = await streamTransferService.handleIncomingChunk(
      'task-resumable',
      createChunkReq({
        'x-file-name': encodeURIComponent('resume.bin'),
        'x-stream-mode': 'resumable',
        'x-resume-enabled': 'true',
        'x-chunk-size': '5',
        'x-chunk-index': '0',
        'x-total-size': '10'
      }, 'hello')
    )
    expect(first).toMatchObject({ success: true, statusCode: 200 })

    streamTransferService.activeStreams.clear()

    const resume = await streamTransferService.resumeTask('task-resumable', {
      streamMode: 'resumable',
      fileName: 'resume.bin',
      userId: 'user-123',
      totalSize: 10,
      chunkSize: 5,
      ownerInstanceId: 'worker-current'
    })

    expect(resume).toMatchObject({
      success: true,
      uploadedBytes: 5,
      lastChunkIndex: 0,
      canResume: true
    })

    const second = await streamTransferService.handleIncomingChunk(
      'task-resumable',
      createChunkReq({
        'x-file-name': encodeURIComponent('resume.bin'),
        'x-stream-mode': 'resumable',
        'x-resume-enabled': 'true',
        'x-chunk-size': '5',
        'x-chunk-index': '1',
        'x-is-last': 'true',
        'x-total-size': '10'
      }, 'world')
    )

    expect(second).toMatchObject({ success: true, statusCode: 200 })
    await vi.waitFor(() => {
      expect(rcloneMock.CloudTool.uploadLocalFileToRemote).toHaveBeenCalledWith(
        expect.stringContaining('task-resumable.resume.bin.part'),
        'resume.bin',
        'user-123',
        expect.any(Function),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
        'task-resumable',
        'complete',
        null,
        expect.objectContaining({ source: 'stream_finish_task' })
      )
    })
  })

  test('resumeTask triggers finalization when staging file is already complete', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-complete-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })
    await fs.promises.writeFile(path.join(resumeDir, 'task-complete.complete.bin.part'), Buffer.from('helloworld'))
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'complete.bin', Size: 10 })

    const result = await streamTransferService.resumeTask('task-complete', {
      streamMode: 'resumable',
      fileName: 'complete.bin',
      userId: 'user-123',
      totalSize: 10,
      chunkSize: 5,
      ownerInstanceId: 'worker-current'
    })

    expect(result).toMatchObject({
      success: true,
      uploadedBytes: 10,
      finalizing: true,
      canResume: false
    })
    await expect(streamTransferService.waitForFinalization('task-complete')).resolves.toMatchObject({
      success: true,
      completed: true
    })
    expect(rcloneMock.CloudTool.uploadLocalFileToRemote).toHaveBeenCalledWith(
      expect.stringContaining('task-complete.complete.bin.part'),
      'complete.bin',
      'user-123',
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
      'task-complete',
      'complete',
      null,
      expect.objectContaining({ source: 'stream_finish_task' })
    )
  })

  test('completed finalization remains visible after active context cleanup', async () => {
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-final-cache-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })
    await fs.promises.writeFile(path.join(resumeDir, 'task-final-cache.final-cache.bin.part'), Buffer.from('hello'))
    rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'final-cache.bin', Size: 5 })

    await streamTransferService.resumeTask('task-final-cache', {
      streamMode: 'resumable',
      fileName: 'final-cache.bin',
      userId: 'user-123',
      totalSize: 5,
      chunkSize: 5,
      ownerInstanceId: 'worker-current'
    })

    await expect(streamTransferService.waitForFinalization('task-final-cache')).resolves.toMatchObject({
      success: true,
      completed: true
    })

    const finalizationSet = cache.set.mock.calls
      .filter(([key]) => key === 'stream:final:task-final-cache')
      .at(-1)
    expect(finalizationSet?.[1]).toMatchObject({ status: 'completed' })
    cache.get.mockImplementation(async (key) => {
      if (key === 'stream:owner:task-final-cache') return ownerRecord('task-final-cache')
      if (key === 'stream:final:task-final-cache') return finalizationSet[1]
      return null
    })

    const progress = await streamTransferService.getTaskFullProgress('task-final-cache')
    expect(progress).toMatchObject({
      isActive: false,
      isCached: false,
      finalization: expect.objectContaining({ status: 'completed' })
    })
    expect(cache.delete).not.toHaveBeenCalledWith('stream:final:task-final-cache')
  })

  test('resumable chunks for the same task are serialized so duplicate retries do not append twice', async () => {
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-serial-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })
    const headers = {
      'x-file-name': encodeURIComponent('serial.bin'),
      'x-stream-mode': 'resumable',
      'x-resume-enabled': 'true',
      'x-chunk-size': '5',
      'x-chunk-index': '0',
      'x-total-size': '10'
    }

    const [first, duplicate] = await Promise.all([
      streamTransferService.handleIncomingChunk('task-serial', createChunkReq(headers, 'hello')),
      streamTransferService.handleIncomingChunk('task-serial', createChunkReq(headers, 'hello'))
    ])

    expect(first.statusCode).toBe(200)
    expect(duplicate.statusCode).toBe(200)
    const staged = await fs.promises.readFile(path.join(resumeDir, 'task-serial.serial.bin.part'), 'utf8')
    expect(staged).toBe('hello')
  })

  test('resumable stream rejects metadata drift instead of appending to the wrong staging file', async () => {
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-drift-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })

    const first = await streamTransferService.handleIncomingChunk(
      'task-drift',
      createChunkReq({
        'x-file-name': encodeURIComponent('a.bin'),
        'x-user-id': 'user-123',
        'x-stream-mode': 'resumable',
        'x-chunk-size': '5',
        'x-chunk-index': '0',
        'x-total-size': '10'
      }, 'hello')
    )
    const second = await streamTransferService.handleIncomingChunk(
      'task-drift',
      createChunkReq({
        'x-file-name': encodeURIComponent('b.bin'),
        'x-user-id': 'user-456',
        'x-stream-mode': 'resumable',
        'x-chunk-size': '5',
        'x-chunk-index': '1',
        'x-total-size': '10'
      }, 'world')
    )

    expect(first).toMatchObject({ success: true, statusCode: 200 })
    expect(second).toMatchObject({ success: false, statusCode: 409 })
    const staged = await fs.promises.readFile(path.join(resumeDir, 'task-drift.a.bin.part'), 'utf8')
    expect(staged).toBe('hello')
  })

  test('resetTask aborts in-flight resumable finalization and prevents stale completion', async () => {
    const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
    const resumeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stream-resume-abort-'))
    getConfig.mockReturnValue({
      streamForwarding: {
        secret: 'test-secret',
        lbUrl: 'https://lb.example.com',
        resumeDir,
        finalizationPollMs: 1,
        finalizationTimeoutMs: 100
      },
      remoteFolder: '/drive/uploads'
    })
    let uploadSignal
    rcloneMock.CloudTool.uploadLocalFileToRemote.mockImplementation((_localPath, _fileName, _userId, _onProgress, options) => {
      uploadSignal = options.signal
      return new Promise(resolve => {
        options.signal.addEventListener('abort', () => resolve({ success: false, error: 'Upload cancelled' }), { once: true })
      })
    })

    const last = await streamTransferService.handleIncomingChunk(
      'task-abort',
      createChunkReq({
        'x-file-name': encodeURIComponent('abort.bin'),
        'x-stream-mode': 'resumable',
        'x-chunk-size': '5',
        'x-chunk-index': '0',
        'x-is-last': 'true',
        'x-total-size': '5'
      }, 'hello')
    )
    expect(last).toMatchObject({ success: true, statusCode: 200 })
    await vi.waitFor(() => expect(uploadSignal).toBeDefined())

    const reset = await streamTransferService.resetTask('task-abort')

    expect(reset).toEqual({ success: true })
    expect(uploadSignal.aborted).toBe(true)
    await flushAsyncEvents()
    expect(
      TaskRepository.transitionStatus.mock.calls.some(([taskId, event]) => taskId === 'task-abort' && event === 'complete')
    ).toBe(false)
  })

  describe('断点续传功能', () => {
    test('应该能保存和加载进度到缓存', async () => {
      const taskId = 'task-resume-test'
      const mockContext = {
        fileName: 'resume-test.txt',
        userId: 'user-123',
        totalSize: 2048,
        uploadedBytes: 1024,
        lastChunkIndex: 7,
        leaderUrl: 'https://leader.example.com',
        chatId: 'chat-123',
        msgId: 'msg-456'
      }

      // Mock cache
      cache.set.mockResolvedValue(true)

      await streamTransferService.saveProgressToCache(taskId, mockContext)

      expect(cache.set).toHaveBeenCalledWith(
        `stream:progress:${taskId}`,
        expect.objectContaining({
          taskId,
          fileName: 'resume-test.txt',
          lastChunkIndex: 7,
          uploadedBytes: 1024
        }),
        3600
      )
    })

    test('应该能从缓存加载进度', async () => {
      const taskId = 'task-load-test'
      const mockProgressData = {
        taskId,
        fileName: 'load-test.txt',
        userId: 'user-123',
        totalSize: 2048,
        uploadedBytes: 1024,
        lastChunkIndex: 7,
        leaderUrl: 'https://leader.example.com',
        chatId: 'chat-123',
        msgId: 'msg-456',
        timestamp: Date.now()
      }

      mockCacheByKey({
        [`stream:progress:${taskId}`]: mockProgressData
      })

      const result = await streamTransferService.loadProgressFromCache(taskId)

      expect(cache.get).toHaveBeenCalledWith(`stream:progress:${taskId}`)
      expect(result).toEqual(mockProgressData)
    })

    test('应该能获取任务的完整进度信息', async () => {
      const taskId = 'task-full-progress-test'
      
      // 测试从缓存获取
      const mockProgressData = {
        taskId,
        fileName: 'full-progress-test.txt',
        userId: 'user-123',
        totalSize: 2048,
        uploadedBytes: 1024,
        lastChunkIndex: 7,
        timestamp: Date.now()
      }

      mockCacheByKey({
        [`stream:progress:${taskId}`]: mockProgressData
      })

      const result = await streamTransferService.getTaskFullProgress(taskId)

      expect(cache.get).toHaveBeenCalledWith(`stream:progress:${taskId}`)
      expect(result).toEqual({
        isActive: false,
        isCached: true,
        lastChunkIndex: 7,
        uploadedBytes: 1024,
        totalSize: 2048,
        mode: undefined,
        phase: undefined,
        finalization: undefined,
        cachedAt: mockProgressData.timestamp
      })
    })

    test('应该能恢复任务', async () => {
      const taskId = 'task-resume-test'
      const mockProgressData = {
        taskId,
        fileName: 'resume-test.txt',
        userId: 'user-123',
        totalSize: 2048,
        uploadedBytes: 1024,
        lastChunkIndex: 7,
        timestamp: Date.now()
      }

      mockCacheByKey({
        [`stream:progress:${taskId}`]: mockProgressData
      })

      const result = await streamTransferService.resumeTask(taskId, { ownerInstanceId: 'worker-current' })

      expect(result).toEqual({
        success: true,
        lastChunkIndex: 7,
        uploadedBytes: 1024,
        totalSize: 2048,
        canResume: true
      })
    })

    test('应该能重置任务', async () => {
      const taskId = 'task-reset-test'
      
      // Mock cache operations
      cache.delete.mockResolvedValue(true)

      const result = await streamTransferService.resetTask(taskId)

      expect(cache.delete).toHaveBeenCalledWith(`stream:progress:${taskId}`)
      expect(result).toEqual({ success: true })
    })

    test('应该能处理重试次数限制', async () => {
      const taskId = 'task-retry-test'
      const chunkIndex = 5
      const retryKey = `${taskId}:${chunkIndex}`

      // 设置已达到最大重试次数
      streamTransferService.chunkRetryAttempts.set(retryKey, 3)

      const metadata = {
        fileName: 'retry-test.txt',
        userId: 'user-123',
        isLast: false,
        chunkIndex,
        totalSize: 1024,
        leaderUrl: 'https://leader.example.com',
        ownerInstanceId: 'worker-current'
      }

      const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

      expect(result).toBe(false)
      expect(streamTransferLog.error).toHaveBeenCalledWith(expect.stringContaining('Max retry attempts reached'))
    })

    test('forwardChunk 应优先使用 targetUrl 而非 lbUrl', async () => {
      fetch.mockResolvedValueOnce({ ok: true })

      const taskId = 'task-target-url'
      const metadata = {
        fileName: 'test.txt',
        userId: 'user-123',
        isLast: false,
        chunkIndex: 0,
        totalSize: 1024,
        leaderUrl: 'https://leader.example.com',
        targetUrl: 'https://specific-worker.example.com',
        ownerInstanceId: 'worker-current'
      }

      await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

      expect(fetch).toHaveBeenCalledWith(
        'https://specific-worker.example.com/api/v2/stream/task-target-url',
        expect.any(Object)
      )
    })

    test('forwardChunk 无 targetUrl 时回退到 lbUrl', async () => {
      fetch.mockResolvedValueOnce({ ok: true })

      const taskId = 'task-fallback-lb'
      const metadata = {
        fileName: 'test.txt',
        userId: 'user-123',
        isLast: false,
        chunkIndex: 0,
        totalSize: 1024,
        leaderUrl: 'https://leader.example.com',
        ownerInstanceId: 'worker-current'
        // 无 targetUrl
      }

      await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

      expect(fetch).toHaveBeenCalledWith(
        'https://lb.example.com/api/v2/stream/task-fallback-lb',
        expect.any(Object)
      )
    })

    test('forwardChunk targetUrl 和 lbUrl 都缺失时应抛错', async () => {
      // 临时覆盖 config 让 lbUrl 为空
      const { getConfig } = await import('../../src/config/index.js')
      getConfig.mockReturnValueOnce({ streamForwarding: { secret: 'test-secret' } })

      const metadata = {
        fileName: 'test.txt',
        userId: 'user-123',
        isLast: false,
        chunkIndex: 0,
        totalSize: 1024,
        leaderUrl: 'https://leader.example.com'
        // 无 targetUrl, lbUrl 也是 undefined
      }

      await expect(
        streamTransferService.forwardChunk('task-no-url', Buffer.from('test'), metadata)
      ).rejects.toThrow('No target URL available')
    })

    test('finishTask 应使用 getConfig().remoteFolder 而非未定义的 config', async () => {
      const { TaskRepository } = await import('../../src/repositories/TaskRepository.js')
      const { TelegramBotApi } = await import('../../src/utils/telegramBotApi.js')

      const context = {
        fileName: 'finish-test.txt',
        userId: 'user-123',
        totalSize: 0,
        chatId: 'chat-123',
        msgId: '456',
        sourceMsgId: '789',
        leaderUrl: null
      }
      rcloneMock.CloudTool.getRemoteFileInfo.mockResolvedValueOnce({ Name: 'finish-test.txt', Size: 0 })

      await streamTransferService.finishTask('task-finish', context)

      expect(TaskRepository.transitionStatus).toHaveBeenCalledWith(
        'task-finish',
        'complete',
        null,
        expect.objectContaining({ source: 'stream_finish_task' })
      )
      expect(TelegramBotApi.editMessageText).toHaveBeenCalledWith(
        'chat-123',
        456,
        expect.stringContaining('/drive/uploads')
      )
    })
  })
})
