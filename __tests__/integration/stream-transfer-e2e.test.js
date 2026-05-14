/**
 * Stream Transfer 集成测试
 *
 * 测试目标：WebhookRouter → StreamTransferService 全链路
 * 只 mock 外部 I/O 边界（网络、DB、Redis、rclone 进程），
 * 让路由分发和服务层逻辑走真实代码。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { Writable } from 'stream'
import { EventEmitter } from 'events'
import { handleWebhook, setAppReadyState } from '../../src/webhook/WebhookRouter.js'

// ─── 外部 I/O mock ───

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn(() => ({
    streamForwarding: {
      secret: 'integration-secret',
      lbUrl: 'https://lb.example.com',
      enabled: true
    },
    port: 3000,
    remoteFolder: '/drive/test'
  }))
}))

vi.mock('../../src/services/CacheService.js', () => {
  const store = new Map()
  return {
    CacheService: {
      get: vi.fn(async (key) => store.get(key) || null),
      set: vi.fn(async (key, value) => { store.set(key, value) }),
      delete: vi.fn(async (key) => { store.delete(key) }),
      _store: store
    }
  }
})

vi.mock('../../src/repositories/TaskRepository.js', () => ({
  TaskRepository: {
    updateStatus: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('../../src/utils/telegramBotApi.js', () => ({
  TelegramBotApi: {
    editMessageText: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    instanceId: 'integration-instance',
    getActiveInstances: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('../../src/services/logger/index.js', () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
  const logger = {
    ...mockLog,
    withModule: vi.fn().mockReturnValue({
      ...mockLog,
      withContext: vi.fn().mockReturnValue({ ...mockLog })
    })
  }
  return { logger, default: logger }
})

// 模拟 rclone rcat：返回一个可写流和进程对象
function createMockRcatStream() {
  const chunks = []
  const stdin = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk)
      callback()
    }
  })
  const proc = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()

  return { stdin, proc, chunks }
}

let mockRcat = null

vi.mock('../../src/services/rclone.js', () => ({
  CloudTool: {
    createRcatStream: vi.fn(() => {
      mockRcat = createMockRcatStream()
      return { stdin: mockRcat.stdin, proc: mockRcat.proc }
    })
  }
}))

vi.mock('../../src/services/QueueService.js', () => ({
  queueService: {
    verifyWebhookSignature: vi.fn().mockResolvedValue(true)
  }
}))

vi.mock('../../src/services/MediaGroupBuffer.js', () => ({
  default: { handleFlushEvent: vi.fn() }
}))

vi.mock('../../src/processor/TaskManager.js', () => ({
  TaskManager: {
    handleDownloadWebhook: vi.fn(),
    handleUploadWebhook: vi.fn(),
    handleMediaBatchWebhook: vi.fn(),
    retryTask: vi.fn()
  }
}))

// ─── helpers ───

function createReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const defaultHeaders = { host: 'localhost', ...headers }
  const req = {
    method,
    url,
    headers: defaultHeaders,
    [Symbol.asyncIterator]: async function* () {
      if (body) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return req
}

function createRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: '',
    writeHead: vi.fn(function (status, headers) {
      res._status = status
      res._headers = headers
    }),
    end: vi.fn(function (data) {
      res._body = data || ''
    })
  }
  return res
}

// ─── 测试 ───

describe('Stream Transfer 集成测试 (WebhookRouter → StreamTransferService)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    setAppReadyState(true)
    global.appInitializer = { businessModulesRunning: true }
    mockRcat = null

    // 清理 StreamTransferService 内部状态
    const { streamTransferService } = await import('../../src/services/StreamTransferService.js')
    streamTransferService.activeStreams.clear()
    streamTransferService.chunkRetryAttempts.clear()
  })

  afterEach(() => {
    delete global.appInitializer
  })

  // ── 鉴权 ──

  describe('鉴权', () => {
    test('缺少 x-instance-secret 应返回 401', async () => {
      const req = createReq({ method: 'GET', url: '/api/v2/stream/task-1/progress' })
      const res = createRes()

      await handleWebhook(req, res)

      expect(res._status).toBe(401)
      expect(res._body).toBe('Unauthorized')
    })

    test('错误的 secret 应返回 401', async () => {
      const req = createReq({
        method: 'GET',
        url: '/api/v2/stream/task-1/progress',
        headers: { 'x-instance-secret': 'wrong' }
      })
      const res = createRes()

      await handleWebhook(req, res)

      expect(res._status).toBe(401)
    })

    test('正确的 secret 应正常处理', async () => {
      const req = createReq({
        method: 'GET',
        url: '/api/v2/stream/task-1/progress',
        headers: { 'x-instance-secret': 'integration-secret' }
      })
      const res = createRes()

      await handleWebhook(req, res)

      expect(res._status).toBe(200)
    })
  })

  // ── chunk 接收 ──

  describe('chunk 接收 (POST /api/v2/stream/:taskId)', () => {
    test('首个 chunk 应创建 rcat 流并写入数据', async () => {
      const req = createReq({
        method: 'POST',
        url: '/api/v2/stream/task-chunk-1',
        headers: {
          'x-instance-secret': 'integration-secret',
          'x-file-name': encodeURIComponent('test.txt'),
          'x-user-id': 'user-1',
          'x-is-last': 'false',
          'x-chunk-index': '0',
          'x-total-size': '1024',
          'x-leader-url': 'https://leader.example.com',
          'x-source-instance-id': 'leader-id',
          'x-chat-id': 'chat-1',
          'x-msg-id': 'msg-1',
          'x-resume-enabled': 'true'
        },
        body: 'chunk-data-0'
      })
      const res = createRes()

      await handleWebhook(req, res)

      expect(res._status).toBe(200)
      expect(res._body).toBe('OK')
      expect(mockRcat).not.toBeNull()
      expect(mockRcat.chunks).toHaveLength(1)
      expect(mockRcat.chunks[0].toString()).toBe('chunk-data-0')
    })

    test('多个 chunk 应写入同一个 rcat 流', async () => {
      const baseHeaders = {
        'x-instance-secret': 'integration-secret',
        'x-file-name': encodeURIComponent('multi.txt'),
        'x-user-id': 'user-1',
        'x-total-size': '3072',
        'x-leader-url': 'https://leader.example.com',
        'x-source-instance-id': 'leader-id',
        'x-chat-id': 'chat-1',
        'x-msg-id': 'msg-1',
        'x-resume-enabled': 'true'
      }

      // chunk 0
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-multi',
        headers: { ...baseHeaders, 'x-chunk-index': '0', 'x-is-last': 'false' },
        body: 'aaa'
      }), createRes())

      // chunk 1
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-multi',
        headers: { ...baseHeaders, 'x-chunk-index': '1', 'x-is-last': 'false' },
        body: 'bbb'
      }), createRes())

      // chunk 2 (last)
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-multi',
        headers: { ...baseHeaders, 'x-chunk-index': '2', 'x-is-last': 'true' },
        body: 'ccc'
      }), createRes())

      expect(mockRcat.chunks).toHaveLength(3)
      expect(Buffer.concat(mockRcat.chunks).toString()).toBe('aaabbbccc')
    })

    test('重复 chunk 应被幂等跳过', async () => {
      const baseHeaders = {
        'x-instance-secret': 'integration-secret',
        'x-file-name': encodeURIComponent('idem.txt'),
        'x-user-id': 'user-1',
        'x-total-size': '2048',
        'x-leader-url': 'https://leader.example.com',
        'x-source-instance-id': 'leader-id',
        'x-chat-id': 'chat-1',
        'x-msg-id': 'msg-1',
        'x-resume-enabled': 'true'
      }

      const res1 = createRes()
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-idem',
        headers: { ...baseHeaders, 'x-chunk-index': '0', 'x-is-last': 'false' },
        body: 'first'
      }), res1)

      // 重复发送 chunk 0
      const res2 = createRes()
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-idem',
        headers: { ...baseHeaders, 'x-chunk-index': '0', 'x-is-last': 'false' },
        body: 'duplicate'
      }), res2)

      // 路由层成功时统一返回 'OK'，但重复 chunk 不应写入 rcat
      expect(res2._status).toBe(200)
      expect(mockRcat.chunks).toHaveLength(1)
      expect(mockRcat.chunks[0].toString()).toBe('first')
    })

    test('last chunk 后应结束 stdin 流', async () => {
      const req = createReq({
        method: 'POST',
        url: '/api/v2/stream/task-last',
        headers: {
          'x-instance-secret': 'integration-secret',
          'x-file-name': encodeURIComponent('last.txt'),
          'x-user-id': 'user-1',
          'x-is-last': 'true',
          'x-chunk-index': '0',
          'x-total-size': '5',
          'x-leader-url': '',
          'x-source-instance-id': 'leader-id',
          'x-chat-id': 'chat-1',
          'x-msg-id': 'msg-1',
          'x-resume-enabled': 'true'
        },
        body: 'final'
      })
      const res = createRes()

      await handleWebhook(req, res)

      expect(res._status).toBe(200)
      // stdin 应该被 end 了
      expect(mockRcat.stdin.writableEnded || mockRcat.stdin.destroyed).toBeTruthy()
    })
  })

  // ── 进度查询 ──

  describe('进度查询', () => {
    test('GET progress 在收到 chunk 后应返回正确的 lastChunkIndex', async () => {
      const baseHeaders = {
        'x-instance-secret': 'integration-secret',
        'x-file-name': encodeURIComponent('prog.txt'),
        'x-user-id': 'user-1',
        'x-total-size': '3072',
        'x-leader-url': 'https://leader.example.com',
        'x-source-instance-id': 'leader-id',
        'x-chat-id': 'chat-1',
        'x-msg-id': 'msg-1',
        'x-resume-enabled': 'true'
      }

      // 发送 chunk 0 和 chunk 1
      for (let i = 0; i < 2; i++) {
        await handleWebhook(createReq({
          method: 'POST',
          url: '/api/v2/stream/task-prog',
          headers: { ...baseHeaders, 'x-chunk-index': String(i), 'x-is-last': 'false' },
          body: `chunk-${i}`
        }), createRes())
      }

      // 查询进度
      const res = createRes()
      await handleWebhook(createReq({
        method: 'GET',
        url: '/api/v2/stream/task-prog/progress',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      expect(res._status).toBe(200)
      const body = JSON.parse(res._body)
      expect(body.lastChunkIndex).toBe(1)
    })

    test('GET full-progress 应返回活跃流状态', async () => {
      // 先发一个 chunk 建立活跃流
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-fullprog',
        headers: {
          'x-instance-secret': 'integration-secret',
          'x-file-name': encodeURIComponent('fp.txt'),
          'x-user-id': 'user-1',
          'x-is-last': 'false',
          'x-chunk-index': '0',
          'x-total-size': '1024',
          'x-leader-url': '',
          'x-source-instance-id': '',
          'x-chat-id': 'c',
          'x-msg-id': 'm',
          'x-resume-enabled': 'true'
        },
        body: 'data'
      }), createRes())

      const res = createRes()
      await handleWebhook(createReq({
        method: 'GET',
        url: '/api/v2/stream/task-fullprog/full-progress',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      const body = JSON.parse(res._body)
      expect(body.isActive).toBe(true)
      expect(body.lastChunkIndex).toBe(0)
      expect(body.uploadedBytes).toBe(4) // 'data'.length
    })

    test('GET full-progress 无活跃流时应从缓存读取', async () => {
      const { CacheService } = await import('../../src/services/CacheService.js')
      CacheService.get.mockResolvedValueOnce({
        taskId: 'task-cached',
        fileName: 'cached.txt',
        userId: 'user-1',
        totalSize: 2048,
        uploadedBytes: 1024,
        lastChunkIndex: 7,
        timestamp: Date.now()
      })

      const res = createRes()
      await handleWebhook(createReq({
        method: 'GET',
        url: '/api/v2/stream/task-cached/full-progress',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      const body = JSON.parse(res._body)
      expect(body.isActive).toBe(false)
      expect(body.isCached).toBe(true)
      expect(body.lastChunkIndex).toBe(7)
      expect(body.uploadedBytes).toBe(1024)
    })

    test('GET progress 无任何记录时应返回 -1', async () => {
      const res = createRes()
      await handleWebhook(createReq({
        method: 'GET',
        url: '/api/v2/stream/task-unknown/progress',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      const body = JSON.parse(res._body)
      expect(body.lastChunkIndex).toBe(-1)
    })
  })

  // ── resume / reset ──

  describe('resume 和 reset', () => {
    test('POST resume 应返回缓存的进度信息', async () => {
      const { CacheService } = await import('../../src/services/CacheService.js')
      CacheService.get.mockResolvedValueOnce({
        taskId: 'task-resume',
        fileName: 'resume.txt',
        userId: 'user-1',
        totalSize: 4096,
        uploadedBytes: 2048,
        lastChunkIndex: 15,
        timestamp: Date.now()
      })

      const res = createRes()
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-resume/resume',
        headers: { 'x-instance-secret': 'integration-secret' },
        body: {}
      }), res)

      const body = JSON.parse(res._body)
      expect(body.success).toBe(true)
      expect(body.lastChunkIndex).toBe(15)
      expect(body.canResume).toBe(true)
    })

    test('DELETE reset 应清除活跃流和缓存', async () => {
      const { CacheService } = await import('../../src/services/CacheService.js')

      // 先建立活跃流
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-reset',
        headers: {
          'x-instance-secret': 'integration-secret',
          'x-file-name': encodeURIComponent('reset.txt'),
          'x-user-id': 'user-1',
          'x-is-last': 'false',
          'x-chunk-index': '0',
          'x-total-size': '1024',
          'x-leader-url': '',
          'x-source-instance-id': '',
          'x-chat-id': 'c',
          'x-msg-id': 'm',
          'x-resume-enabled': 'true'
        },
        body: 'data'
      }), createRes())

      // 确认活跃流存在
      const { streamTransferService } = await import('../../src/services/StreamTransferService.js')
      expect(streamTransferService.activeStreams.has('task-reset')).toBe(true)

      // 执行 reset
      const res = createRes()
      await handleWebhook(createReq({
        method: 'DELETE',
        url: '/api/v2/stream/task-reset/reset',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      const body = JSON.parse(res._body)
      expect(body.success).toBe(true)

      // 活跃流应被清除
      expect(streamTransferService.activeStreams.has('task-reset')).toBe(false)

      // 缓存也应被清除
      expect(CacheService.delete).toHaveBeenCalledWith('stream:progress:task-reset')
    })
  })

  // ── 路由匹配 ──

  describe('路由匹配边界', () => {
    test('POST /api/v2/stream/:taskId/resume 应走 resume 路由而非 chunk 路由', async () => {
      const { CacheService } = await import('../../src/services/CacheService.js')
      CacheService.get.mockResolvedValueOnce(null)

      const res = createRes()
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-route/resume',
        headers: { 'x-instance-secret': 'integration-secret' },
        body: {}
      }), res)

      // 应返回 resume 结果（非 chunk 接收结果）
      const body = JSON.parse(res._body)
      expect(body.success).toBe(false) // 缓存为空，resume 失败
      expect(body.canResume).toBe(false)
    })

    test('POST /api/v2/stream/:taskId 应走 chunk 路由', async () => {
      const res = createRes()
      await handleWebhook(createReq({
        method: 'POST',
        url: '/api/v2/stream/task-chunk-route',
        headers: {
          'x-instance-secret': 'integration-secret',
          'x-file-name': encodeURIComponent('r.txt'),
          'x-user-id': 'u',
          'x-is-last': 'false',
          'x-chunk-index': '0',
          'x-total-size': '100',
          'x-leader-url': '',
          'x-source-instance-id': '',
          'x-chat-id': 'c',
          'x-msg-id': 'm',
          'x-resume-enabled': 'true'
        },
        body: 'ok'
      }), res)

      // chunk 路由返回纯文本 'OK'
      expect(res._body).toBe('OK')
      expect(res._status).toBe(200)
    })

    test('未匹配的 stream 子路径应 fall through', async () => {
      const res = createRes()
      await handleWebhook(createReq({
        method: 'GET',
        url: '/api/v2/stream/task-1/nonexistent',
        headers: { 'x-instance-secret': 'integration-secret' }
      }), res)

      // 不应匹配任何 stream 路由，落入后续流程（无签名 → 401）
      expect(res._status).toBe(401)
    })
  })
})
