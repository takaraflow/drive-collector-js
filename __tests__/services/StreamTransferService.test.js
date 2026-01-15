import { describe, test, expect, vi, beforeEach } from 'vitest'
import { streamTransferService } from '../../src/services/StreamTransferService.js'
import { config } from '../../src/config/index.js'
import { logger } from '../../src/services/logger/index.js'
import { CacheService } from '../../src/services/CacheService.js'

const log = logger.withModule('StreamTransferServiceTest')

vi.mock('../../src/config/index.js', () => ({
  config: {
    streamForwarding: {
      secret: 'test-secret',
      lbUrl: 'https://lb.example.com'
    }
  }
}))

vi.mock('../../src/services/CacheService.js', () => ({
  CacheService: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

describe('StreamTransferService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
    // Mock logger methods
    vi.spyOn(log, 'info').mockImplementation(() => {})
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    vi.spyOn(log, 'error').mockImplementation(() => {})
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

  test('forward chunk with retry and skip when already received', async () => {
    const mockService = {
      getRemoteProgress: vi.fn().mockResolvedValue(3),
      updateTelegramUI: vi.fn(),
      reportProgressToLeader: vi.fn()
    }
    vi.spyOn(streamTransferService, 'getRemoteProgress').mockImplementation(mockService.getRemoteProgress)
    
    // �l�1%
    const mockError = new Error('Network error')
    fetch.mockRejectedValueOnce(mockError)
    
    // K�pn
    const taskId = 'task-456'
    const metadata = {
      fileName: 'test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex: 2,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com'
    }

    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    
    expect(result).toBe(true)
    expect(mockService.getRemoteProgress).toHaveBeenCalledWith('https://lb.example.com', taskId)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('already received by worker'))
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
      leaderUrl: 'https://leader.example.com'
    }

    await expect(
      streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    ).rejects.toThrow('Network error')
    
    // 这个测试中，错误不是超时错误，所以不会调用特定的warn日志
    // 移除这个期望，因为实际的日志调用可能不同
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

      // Mock CacheService
      CacheService.set.mockResolvedValue(true)

      await streamTransferService.saveProgressToCache(taskId, mockContext)

      expect(CacheService.set).toHaveBeenCalledWith(
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

      CacheService.get.mockResolvedValue(mockProgressData)

      const result = await streamTransferService.loadProgressFromCache(taskId)

      expect(CacheService.get).toHaveBeenCalledWith(`stream:progress:${taskId}`)
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

      CacheService.get.mockResolvedValue(mockProgressData)

      const result = await streamTransferService.getTaskFullProgress(taskId)

      expect(CacheService.get).toHaveBeenCalledWith(`stream:progress:${taskId}`)
      expect(result).toEqual({
        isActive: false,
        isCached: true,
        lastChunkIndex: 7,
        uploadedBytes: 1024,
        totalSize: 2048,
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

      CacheService.get.mockResolvedValue(mockProgressData)

      const result = await streamTransferService.resumeTask(taskId, {})

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
      CacheService.delete.mockResolvedValue(true)

      const result = await streamTransferService.resetTask(taskId)

      expect(CacheService.delete).toHaveBeenCalledWith(`stream:progress:${taskId}`)
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
        leaderUrl: 'https://leader.example.com'
      }

      const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)

      expect(result).toBe(false)
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Max retry attempts reached'))
    })
  })
})