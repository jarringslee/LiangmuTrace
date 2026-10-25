import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import { createServer } from 'vite'

const originalFetch = globalThis.fetch
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
let vite, source, api, storage
const analysis = {
  id: 'analysis-test', batchId: 'batch-test', basedOnVersion: 1, reviewVersion: 2,
  modelName: 'mock-model', promptVersion: 'audit-risk-v1', createdAt: '2026-10-04T08:00:00Z',
  mode: 'api', riskLevel: 'low', recommendation: 'manualReview', summary: '请人工核对种植环境。',
  missingInformation: [], evidence: [{ sourceId: 'batch:identity', note: '已读取丹参批次' }],
  toolCalls: [], stale: false,
}
const progress = { seq: 1, stage: 'snapshot', status: 'completed', message: '已读取丹参资料', at: analysis.createdAt }
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const options = (onProgress = () => undefined, signal = new AbortController().signal) => ({ signal, onProgress })
function streamResponse(text, splitBytes = false) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  return new Response(new ReadableStream({ start(controller) {
    if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    else controller.enqueue(bytes)
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}
beforeEach(async () => {
  const values = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key),
  } })
  vite = await createServer({
    cacheDir: 'node_modules/.vite-tests/risk-stream',
    mode: 'development', server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('api'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
  })
  source = await vite.ssrLoadModule('/src/services/herbDataSource.ts')
  api = await vite.ssrLoadModule('/src/services/api.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  await vite.close()
  globalThis.fetch = originalFetch
  if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage)
  else delete globalThis.sessionStorage
})

test('SSE 解析跨字节中文、跨块 CRLF、多行 data 与心跳，只在完整 result 后成功', async () => {
  const pretty = JSON.stringify(progress, null, 2).split('\n').map((line) => `data: ${line}`).join('\r\n')
  const second = { ...progress, seq: 2, stage: 'model', status: 'running', message: '正在请求模型' }
  const text = `: keep-alive\r\n\r\nevent: progress\r\n${pretty}\r\n\r\n`
    + frame('progress', second) + frame('result', { analysis }) + frame('error', { status: 500, code: 'LATE', message: '终态后不再处理' })
  let calls = 0
  globalThis.fetch = async (url, request) => {
    calls += 1
    assert.equal(url, '/api/batches/batch-test/risk-analysis/stream')
    assert.equal(request.method, 'POST')
    assert.equal(request.credentials, 'include'); assert.equal(request.headers.Authorization, undefined)
    assert.equal(request.headers.Accept, 'text/event-stream')
    return streamResponse(text, true)
  }
  const records = []
  assert.deepEqual(await source.streamBatchRisk('batch-test', options((item) => records.push(item))), analysis)
  assert.deepEqual(records, [progress, second])
  assert.equal(calls, 1)
})

test('SSE 拒绝无 result、错误顺序/批次/JSON/UTF-8、超大消息及非事件流响应', async () => {
  const cases = [
    [streamResponse(frame('progress', progress)), 'STREAM_INCOMPLETE'],
    [streamResponse(frame('progress', { ...progress, seq: 2 })), 'STREAM_INVALID'],
    [streamResponse(frame('result', { analysis: { ...analysis, batchId: 'other-batch' } })), 'STREAM_INVALID'],
    [streamResponse('event: progress\ndata: invalid-json\n\n'), 'STREAM_INVALID'],
    [streamResponse(Uint8Array.of(255)), 'STREAM_INVALID'],
    [streamResponse(`data: ${'x'.repeat(128_001)}`), 'STREAM_INVALID'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json' } }), 'STREAM_INVALID'],
  ]
  for (const [response, code] of cases) {
    globalThis.fetch = async () => response
    await assert.rejects(source.streamBatchRisk('batch-test', options()), { code })
  }
})

test('SSE 兼容 v1/v2 报告，v2 原文必须为有界字符串，不接受未知版本', async () => {
  const updated = { ...analysis, promptVersion: 'audit-risk-v2',
    evidence: [{ sourceId: 'batch:origin', note: '产地已登记', sourceText: '甘肃省定西市' }] }
  globalThis.fetch = async () => streamResponse(frame('result', { analysis: updated }))
  assert.deepEqual(await source.streamBatchRisk('batch-test', options()), updated)
  for (const invalid of [{ ...updated, promptVersion: 'unknown' },
    { ...updated, evidence: [{ sourceId: 'batch:origin', note: 'v2 缺少资料快照' }] },
    { ...updated, evidence: [{ ...updated.evidence[0], sourceText: {} }] },
    { ...updated, evidence: [{ ...updated.evidence[0], sourceText: 'x'.repeat(601) }] }]) {
    globalThis.fetch = async () => streamResponse(frame('result', { analysis: invalid }))
    await assert.rejects(source.streamBatchRisk('batch-test', options()), { code: 'STREAM_INVALID' })
  }
})

test('SSE 中的业务错误保留错误码，不自动重试或误清理登录', async () => {
  let calls = 0, authFailures = 0
  api.setAuthFailureHandler(() => { authFailures += 1 })
  globalThis.fetch = async () => {
    calls += 1
    return streamResponse(frame('progress', progress)
      + frame('error', { status: 502, code: 'AI_UPSTREAM_ERROR', message: 'AI 服务暂不可用' }))
  }
  await assert.rejects(source.streamBatchRisk('batch-test', options()), { status: 502, code: 'AI_UPSTREAM_ERROR' })
  assert.equal(calls, 1)
  assert.equal(authFailures, 0)
  assert.equal(storage.getAuthUserId(), 'user-A')
})

test('SSE 开始前的 HTTP 401 与 JSON 请求共用登录失效处理', async () => {
  let failures = 0
  api.setAuthFailureHandler(() => { failures += 1 })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'INVALID_TOKEN', message: '登录失效' } }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(source.streamBatchRisk('batch-test', options()), { status: 401, code: 'INVALID_TOKEN' })
  assert.equal(failures, 1)
})

test('主动停止会取消未完成的 reader，已取消的请求不发送 fetch', async () => {
  const controller = new AbortController()
  let cancelled = false, calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  const rejected = assert.rejects(source.streamBatchRisk('batch-test', options(undefined, controller.signal)), { name: 'AbortError' })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await rejected
  assert.equal(cancelled, true)
  await assert.rejects(source.streamBatchRisk('batch-test', options(undefined, controller.signal)), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('进度期间切换账号会丢弃后续旧结果，结束旧连接', async () => {
  let seen = 0
  globalThis.fetch = async () => streamResponse(frame('progress', progress) + frame('result', { analysis }))
  await assert.rejects(source.streamBatchRisk('batch-test', options(() => {
    seen += 1
    storage.advanceAuthRevision('user-B')
  })), { name: 'AbortError' })
  assert.equal(seen, 1)
  assert.equal(storage.getAuthUserId(), 'user-B')
})

test('SSE 整体 70 秒超时包含读取阶段，心跳不重置超时且 身份保留', async (context) => {
  let cancelled = false
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')) },
    cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const rejected = assert.rejects(source.streamBatchRisk('batch-test', options()), { code: 'TIMEOUT' })
  await new Promise((resolve) => setImmediate(resolve))
  context.mock.timers.tick(15_000)
  assert.equal(cancelled, false)
  context.mock.timers.tick(55_000)
  await rejected
  assert.equal(cancelled, true)
  assert.equal(storage.getAuthUserId(), 'user-A')
  context.mock.timers.reset()
})
