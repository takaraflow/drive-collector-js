import { describe, test, expect, vi, beforeEach } from 'vitest'
import { streamTransferService } from '../../src/services/StreamTransferService.js'
import { cache } from '../../src/services/CacheService.js'

vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    streamForwarding: {
      secret: 'test-secret',
      lbUrl: 'https://lb.example.com',
      enabled: true
    },
    downloadDir: '/tmp/downloads',
    remoteFolder: '/remote'
  })
}))

vi.mock('../../src/services/CacheService.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

describe('流式转发续传协议测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
    streamTransferService.chunkRetryAttempts.clear()
    cache.get.mockResolvedValue(null)
    cache.set.mockResolvedValue(true)
    cache.delete.mockResolvedValue(true)
  })

  test('live stream forwarding posts the chunk directly without probing progress', async () => {
    const taskId = 'task-live-no-fake-resume'
    const fileName = 'large-file.zip'
    const totalSize = 100 * 1024 * 1024 // 100MB

    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK')
    })

    const metadata = {
      fileName,
      userId: 'user-123',
      isLast: false,
      chunkIndex: 50,
      totalSize,
      leaderUrl: 'https://leader.example.com',
      chatId: 'chat-123',
      msgId: 'msg-456',
      ownerInstanceId: 'worker-1'
    }

    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test-chunk'), metadata)

    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-live-no-fake-resume',
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from('test-chunk'),
        headers: expect.objectContaining({
          'x-instance-secret': 'test-secret',
          'x-stream-mode': 'live',
          'x-resume-enabled': 'false',
          'x-chunk-index': '50'
        })
      })
    )
  })

  test('live stream forwarding records retry state when the direct post fails', async () => {
    const taskId = 'task-live-retry-state'
    const chunkIndex = 3

    fetch.mockRejectedValueOnce(new Error('Network error'))

    const metadata = {
      fileName: 'fallback-test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex,
      totalSize: 3 * 1024 * 1024,
      leaderUrl: 'https://leader.example.com',
      ownerInstanceId: 'worker-1'
    }

    await expect(
      streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    ).rejects.toThrow('Network error')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-live-retry-state',
      expect.objectContaining({ method: 'POST' })
    )
    expect(streamTransferService.chunkRetryAttempts.get(`${taskId}:${chunkIndex}`)).toBe(1)
  })

  test('resumable stream forwarding marks chunks with resumable protocol headers', async () => {
    const taskId = 'task-resumable-headers'

    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK')
    })

    const metadata = {
      fileName: 'resumable-test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex: 5,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com',
      resumeEnabled: true,
      streamMode: 'resumable',
      chunkSize: 256,
      ownerInstanceId: 'worker-1'
    }

    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-resumable-headers',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-stream-mode': 'resumable',
          'x-resume-enabled': 'true',
          'x-chunk-size': '256'
        })
      })
    )
  })

  test('resumable resume negotiation uses the worker resume endpoint as the progress SSOT', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        uploadedBytes: 1024,
        lastChunkIndex: 1,
        canResume: true
      })
    })

    const metadata = {
      streamMode: 'resumable',
      fileName: 'resume.bin',
      userId: 'user-123',
      totalSize: 2048,
      chunkSize: 512,
      ownerInstanceId: 'worker-1'
    }

    const result = await streamTransferService.resumeTask(
      'task-resume-negotiation',
      metadata,
      'https://worker.example.com/'
    )

    expect(result).toMatchObject({
      success: true,
      uploadedBytes: 1024,
      canResume: true
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://worker.example.com/api/v2/stream/task-resume-negotiation/resume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-instance-secret': 'test-secret'
        }),
        body: JSON.stringify(metadata)
      })
    )
  })
})
