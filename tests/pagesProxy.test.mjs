import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import worker from '../public/_worker.js'

const origin = 'https://liangmutrace.pages.dev'

test('普通页面和相似前缀仍由静态站点处理，只有 API/Socket 进入函数路由', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('不得访问上游') })
  const routes = JSON.parse(readFileSync(new URL('../public/_routes.json', import.meta.url), 'utf8'))
  assert.deepEqual(routes, { version: 1, include: ['/api', '/api/*', '/socket.io', '/socket.io/*'], exclude: [] })
  for (const path of ['/login', '/assets/main.js', '/public/trace/code', '/api-extra', '/socket.io-extra']) {
    const request = new Request(`${origin}${path}`)
    const response = await worker.fetch(request, { ASSETS: { fetch: actual => {
      assert.equal(actual, request)
      return new Response('static')
    } } })
    assert.equal(await response.text(), 'static')
  }
})

test('固定上游保留方法、正文、Cookie、真实来源和 CSRF，清理伪造转发头且不跟随重定向', async t => {
  t.mock.method(globalThis, 'fetch', async (request, options) => {
    assert.equal(request.url, 'https://liangmu-trace-api.onrender.com/api/auth/login?next=https://evil.test')
    assert.equal(request.method, 'POST')
    assert.equal(await request.text(), '{"account":"fixture"}')
    for (const [name, value] of Object.entries({ Cookie: 'liangmu_session=fixture', Origin: 'https://evil.test',
      Referer: 'https://evil.test/login', 'X-Liangmu-CSRF': '1', 'X-Liangmu-User': 'fixture-user' })) {
      assert.equal(request.headers.get(name), value)
    }
    for (const name of ['Host', 'Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto']) {
      assert.equal(request.headers.has(name), false)
    }
    assert.equal(options.redirect, 'manual')
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json({ error: { code: 'CSRF_REJECTED' } }, { status: 403 })
  })
  const response = await worker.fetch(new Request(`${origin}/api/auth/login?next=https://evil.test`, {
    method: 'POST', body: '{"account":"fixture"}', headers: {
      Cookie: 'liangmu_session=fixture', Origin: 'https://evil.test', Referer: 'https://evil.test/login',
      'X-Liangmu-CSRF': '1', 'X-Liangmu-User': 'fixture-user', Host: 'spoof.test',
      Forwarded: 'for=spoof', 'X-Forwarded-For': '1.2.3.4', 'X-Forwarded-Host': 'spoof.test', 'X-Forwarded-Proto': 'http',
    },
  }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'CSRF_REJECTED')
})

test('登录和退出完整保留 Set-Cookie 属性及多个 Cookie，统一禁止认证响应缓存', async t => {
  const cookies = ['liangmu_session=fixture; Path=/; HttpOnly; Secure; SameSite=Lax', 'other=fixture; Path=/']
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 204, headers: [...cookies.map(value => ['Set-Cookie', value]), ['Cache-Control', 'public, max-age=100']],
  }))
  const response = await worker.fetch(new Request(`${origin}/api/auth/logout`, { method: 'POST' }))
  assert.equal(response.status, 204)
  assert.deepEqual(response.headers.getSetCookie(), cookies)
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
})

test('业务/身份错误保留状态、JSON 和 Retry-After，不回退成 HTML', async t => {
  for (const status of [401, 403, 404, 409, 429, 503]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: `ERROR_${status}` } },
      { status, headers: { 'Retry-After': '30' } }))
    const response = await worker.fetch(new Request(`${origin}/api/auth/me`))
    assert.equal(response.status, status)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('retry-after'), '30')
    assert.equal((await response.json()).error.code, `ERROR_${status}`)
  }
})

test('SSE 在上游尚未结束时就能读到首帧，保留事件类型且不缓存/转换', { timeout: 3000 }, async t => {
  let controller
  const stream = new ReadableStream({ start(value) { controller = value } })
  const encoder = new TextEncoder()
  controller.enqueue(encoder.encode('event: preview\ndata: first\n\n'))
  t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.get('X-Liangmu-CSRF'), '1')
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } })
  })
  const response = await worker.fetch(new Request(`${origin}/api/assistant/messages/stream`, {
    method: 'POST', headers: { 'X-Liangmu-CSRF': '1' },
  }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/)
  controller.enqueue(encoder.encode('event: reply\ndata: final\n\n'))
  controller.close()
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: final/)
  assert.equal((await reader.read()).done, true)
})

test('Socket polling 保留查询和 Cookie；WebSocket 101 返回原始升级响应', async t => {
  const upgraded = { status: 101, webSocket: {} }
  t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(new URL(request.url).pathname, '/socket.io/')
    assert.equal(request.headers.get('cookie'), 'liangmu_session=fixture')
    assert.equal(request.headers.get('origin'), origin)
    if (new URL(request.url).searchParams.get('transport') === 'websocket') {
      assert.equal(request.headers.get('upgrade'), 'websocket')
      return upgraded
    }
    assert.equal(new URL(request.url).search, '?EIO=4&transport=polling&t=fixture')
    return new Response('0{"sid":"fixture"}')
  })
  const headers = { Cookie: 'liangmu_session=fixture', Origin: origin }
  assert.match(await (await worker.fetch(new Request(`${origin}/socket.io/?EIO=4&transport=polling&t=fixture`, { headers }))).text(), /sid/)
  assert.equal(await worker.fetch(new Request(`${origin}/socket.io/?EIO=4&transport=websocket`, {
    headers: { ...headers, Upgrade: 'websocket' },
  })), upgraded)
})

test('上游不可达返回可识别的 502 JSON，错误详情及凭证不泄漏', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('private-network-and-cookie-details') })
  const response = await worker.fetch(new Request(`${origin}/api/health`))
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.text()
  assert.match(body, /UPSTREAM_UNAVAILABLE/)
  assert.doesNotMatch(body, /private-network-and-cookie-details/)
})

test('客户端取消信号传给上游，Pages 运行时显式开启断开及信号转发', async t => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'))
  assert.equal(config.pages_build_output_dir, './dist')
  assert.ok(config.compatibility_date >= '2024-11-11', 'cache: no-store 需要启用对应运行时行为')
  assert.ok(config.compatibility_flags.includes('enable_request_signal'))
  assert.ok(config.compatibility_flags.includes('request_signal_passthrough'))
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (request, options) => {
    assert.equal(request.signal.aborted, false)
    assert.equal(options.signal.aborted, false)
    controller.abort()
    assert.equal(request.signal.aborted, true)
    assert.equal(options.signal.aborted, true)
    return new Response(null, { status: 204 })
  })
  await worker.fetch(new Request(`${origin}/api/assistant/messages/stream`, { method: 'POST', signal: controller.signal }))
})
