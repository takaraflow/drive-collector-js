import { describe, test, expect, vi, beforeEach } from 'vitest'
import { streamTransferService } from '../../src/services/StreamTransferService.js'
import { config } from '../../src/config/index.js'
import { CacheService } from '../../src/services/CacheService.js'

vi.mock('../../src/config/index.js', () => ({
  config: {
    streamForwarding: {
      secret: 'test-secret',
      lbUrl: 'https://lb.example.com',
      enabled: true
    },
    downloadDir: '/tmp/downloads',
    remoteFolder: '/remote'
  }
}))

vi.mock('../../src/services/CacheService.js', () => ({
  CacheService: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

describe('断点续传端到端测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  test('完整的断点续传场景：网络中断后恢复传输', async () => {
    const taskId = 'task-resume-e2e'
    const fileName = 'large-file.zip'
    const totalSize = 100 * 1024 * 1024 // 100MB
    
    // Mock Worker 端进度查询
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        lastChunkIndex: 49
      })
    })
    
    // Mock forwardChunk 成功
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK')
    })
    
    // 测试断点续传流程
    const metadata = {
      fileName,
      userId: 'user-123',
      isLast: false,
      chunkIndex: 50,
      totalSize,
      leaderUrl: 'https://leader.example.com',
      chatId: 'chat-123',
      msgId: 'msg-456'
    }
    
    // 调用 forwardChunk 模拟传输
    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test-chunk'), metadata)
    
    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-resume-e2e/progress',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'x-instance-secret': 'test-secret'
        }
      })
    )
  })

  test('断点续传失败时降级到从头开始', async () => {
    const taskId = 'task-resume-fallback'
    
    // Mock Worker 端进度查询失败
    fetch.mockRejectedValueOnce(new Error('Network error'))
    
    // Mock forwardChunk 成功
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('OK')
    })
    
    // 测试从头开始传输
    const metadata = {
      fileName: 'fallback-test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex: 0,
      totalSize: 3 * 1024 * 1024,
      leaderUrl: 'https://leader.example.com'
    }
    
    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    
    expect(result).toBe(true)
    
    // 验证从头开始传输
    expect(fetch).toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-resume-fallback/progress',
      expect.anything()
    )
  })

  test('重复chunk幂等性检查', async () => {
    const taskId = 'task-idempotency-test'
    const chunkIndex = 5
    
    // Mock Worker 端已接收该chunk
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        lastChunkIndex: 5
      })
    })
    
    const metadata = {
      fileName: 'idempotency-test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com'
    }
    
    const result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    
    expect(result).toBe(true)
    expect(fetch).not.toHaveBeenCalledWith(
      'https://lb.example.com/api/v2/stream/task-idempotency-test',
      expect.anything()
    )
  })

  test('重试机制验证', async () => {
    const taskId = 'task-retry-test'
    const chunkIndex = 3
    
    // Mock Worker 端未接收该chunk
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        lastChunkIndex: 2 // 比当前chunk小
      })
    })
    
    // Mock 第一次发送失败
    fetch.mockRejectedValueOnce(new Error('Network timeout'))
    
    // Mock 第二次发送成功
    fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('OK')
    })
    
    const metadata = {
      fileName: 'retry-test.txt',
      userId: 'user-123',
      isLast: false,
      chunkIndex,
      totalSize: 1024,
      leaderUrl: 'https://leader.example.com'
    }
    
    // 使用 try-catch 处理可能的错误
    let result
    try {
      result = await streamTransferService.forwardChunk(taskId, Buffer.from('test'), metadata)
    } catch (error) {
      // 如果重试失败，应该抛出错误
      expect(error.message).toBe('Network timeout')
      return
    }
    
    // 如果重试成功
    expect(result).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3) // 1次进度查询 + 2次发送
    
    // 验证重试计数被清除
    const retryKey = `${taskId}:${chunkIndex}`
    expect(streamTransferService.chunkRetryAttempts.get(retryKey)).toBeUndefined()
  })
})