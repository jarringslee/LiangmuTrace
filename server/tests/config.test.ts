import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import express from 'express'
import { rateLimit } from 'express-rate-limit'

// 独立假配置，HTTP 烟测只访问预检/未认证路由和测试探针，不接数据库/模型。
process.env.NODE_ENV = 'test'
process.env.CLIENT_ORIGIN = 'http://localhost:5173'
process.env.TRUST_PROXY = 'off'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
process.env.JWT_SECRET = 'config-test-only-secret-0123456789abcdef'
const { env, envSchema } = await import('../src/config/env.js')
const { createApp } = await import('../src/app.js')
const { prisma, createPrismaPoolConfig, createPrismaTransactionOptions } = await import('../src/lib/prisma.js')
const app = createApp()
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await prisma.$disconnect()
})
const valid = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'production',
  CLIENT_ORIGIN: 'https://frontend.example.test', JWT_SECRET: process.env.JWT_SECRET }

test('生产要求 HTTPS 前端源与足够长的 JWT 密钥，开发默认仍可启动', () => {
  assert.equal(envSchema.safeParse(valid).success, true)
  for (const override of [{ CLIENT_ORIGIN: undefined }, { CLIENT_ORIGIN: 'http://frontend.example.test' },
    { JWT_SECRET: '' }, { JWT_SECRET: 'short' }]) {
    assert.equal(envSchema.safeParse({ ...valid, ...override }).success, false)
  }
  assert.equal(envSchema.safeParse({ DATABASE_URL: valid.DATABASE_URL }).success, true)
})

test('前端源正规化，拒绝路径/凭证/查询/非网页协议和多源；数据库与端口有边界', () => {
  assert.equal(envSchema.parse({ ...valid, CLIENT_ORIGIN: ' https://FRONTEND.example.test:443/ ' }).CLIENT_ORIGIN,
    'https://frontend.example.test')
  for (const CLIENT_ORIGIN of ['', 'broken', '*', 'https://a.test,https://b.test', 'file:///local',
    'https://user:password@a.test', 'https://a.test/path', 'https://a.test?query=1', 'https://a.test#hash']) {
    assert.equal(envSchema.safeParse({ ...valid, CLIENT_ORIGIN }).success, false)
  }
  for (const DATABASE_URL of ['', 'broken', 'mysql://user:pass@localhost/db', 'postgresql://localhost/']) {
    assert.equal(envSchema.safeParse({ ...valid, DATABASE_URL }).success, false)
  }
  for (const PORT of [0, 65536, 'not-a-port']) assert.equal(envSchema.safeParse({ ...valid, PORT }).success, false)
  assert.equal(envSchema.safeParse({ ...valid, PORT: '4000', DATABASE_URL: 'postgres://localhost/database' }).success, true)
})

test('数据库连接池/事务默认值与配置映射一致，可覆盖且等待有上限', () => {
  const defaults = envSchema.parse(valid)
  assert.equal(defaults.DB_POOL_MAX, 2)
  assert.equal(defaults.DB_CONNECT_TIMEOUT_MS, 15000)
  assert.equal(defaults.DB_TRANSACTION_TIMEOUT_MS, 15000)
  assert.deepEqual(createPrismaPoolConfig(defaults), {
    connectionString: valid.DATABASE_URL, max: 2, connectionTimeoutMillis: 15000,
  })
  assert.deepEqual(createPrismaTransactionOptions(defaults), { maxWait: 15000, timeout: 15000 })
  const configured = envSchema.parse({ ...valid, DB_POOL_MAX: '4', DB_CONNECT_TIMEOUT_MS: '20000',
    DB_TRANSACTION_TIMEOUT_MS: '25000' })
  assert.deepEqual(createPrismaPoolConfig(configured), {
    connectionString: valid.DATABASE_URL, max: 4, connectionTimeoutMillis: 20000,
  })
  assert.deepEqual(createPrismaTransactionOptions(configured), { maxWait: 20000, timeout: 25000 })
})

test('拒绝零值、空值、非整数及越界连接池/连接等待配置', () => {
  for (const DB_POOL_MAX of ['', 0, -1, 1.5, 21, 'not-a-number']) {
    assert.equal(envSchema.safeParse({ ...valid, DB_POOL_MAX }).success, false)
  }
  for (const DB_CONNECT_TIMEOUT_MS of ['', 0, 999, 60001, 15000.5, 'not-a-number']) {
    assert.equal(envSchema.safeParse({ ...valid, DB_CONNECT_TIMEOUT_MS }).success, false)
  }
  for (const DB_POOL_MAX of [1, 20]) {
    assert.equal(envSchema.safeParse({ ...valid, DB_POOL_MAX }).success, true)
  }
  for (const DB_CONNECT_TIMEOUT_MS of [1000, 60000]) {
    assert.equal(envSchema.safeParse({ ...valid, DB_CONNECT_TIMEOUT_MS }).success, true)
  }
  for (const DB_TRANSACTION_TIMEOUT_MS of ['', 0, 999, 60001, 15000.5, 'not-a-number']) {
    assert.equal(envSchema.safeParse({ ...valid, DB_TRANSACTION_TIMEOUT_MS }).success, false)
  }
  for (const DB_TRANSACTION_TIMEOUT_MS of [1000, 60000]) {
    assert.equal(envSchema.safeParse({ ...valid, DB_TRANSACTION_TIMEOUT_MS }).success, true)
  }
})

test('可信代理默认关闭，支持明确 IP/CIDR；拒绝全信任、跳数、/0 与非法值', () => {
  assert.equal(envSchema.parse(valid).TRUST_PROXY, false)
  assert.deepEqual(envSchema.parse({ ...valid, TRUST_PROXY: ' loopback,192.0.2.5,2001:db8::/64 ' }).TRUST_PROXY,
    ['loopback', '192.0.2.5', '2001:db8::/64'])
  for (const TRUST_PROXY of ['', 'true', 'false', '1', '*', 'unknown', '192.0.2.1,',
    '0.0.0.0/0', '::/0', '192.0.2.1/33', '::1/129', '::1/-1', '192.0.2.1/24/1']) {
    assert.equal(envSchema.safeParse({ ...valid, TRUST_PROXY }).success, false)
  }
  assert.equal(app.get('trust proxy'), false)
})

test('允许真实前端源的 Cookie/CSRF 预检，不再放行 Authorization 请求头', async () => {
  const response = await fetch(`${base}/api/batches`, { method: 'OPTIONS', headers: {
    Origin: env.CLIENT_ORIGIN, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-liangmu-csrf,content-type',
  } })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), env.CLIENT_ORIGIN)
  assert.match(response.headers.get('access-control-allow-headers')!, /X-Liangmu-CSRF/)
  assert.match(response.headers.get('access-control-allow-headers')!, /X-Liangmu-User/)
  assert.doesNotMatch(response.headers.get('access-control-allow-headers')!, /Authorization/i)
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
  const denied = await fetch(`${base}/api/batches`, { headers: { Origin: 'https://other.example.test' } })
  assert.equal(denied.headers.get('access-control-allow-origin'), null)
  assert.equal(denied.status, 401)
})

test('所有 API 写操作先检查 CSRF，包括登录/注册、无请求体退出和付费 SSE', async () => {
  for (const [path, method] of [
    ['/auth/login', 'POST'], ['/auth/register', 'POST'], ['/auth/logout', 'POST'],
    ['/accounts', 'POST'], ['/batches', 'POST'], ['/notifications/notice/read', 'PATCH'],
    ['/chat/conversations', 'POST'], ['/batches/batch/risk-analysis/stream', 'POST'],
    ['/assistant/conversation/messages/stream', 'POST'],
  ]) {
    const response = await fetch(`${base}/api${path}`, { method })
    assert.equal(response.status, 403, path)
    assert.equal((await response.json()).error.code, 'CSRF_REJECTED')
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

test('CSRF 拒绝简单表单、错误自定义头、伪造/空来源和无效 Referer', async () => {
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: env.CLIENT_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    { Origin: env.CLIENT_ORIGIN, 'X-Liangmu-CSRF': 'wrong' },
    ...['null', 'https://evil.example.test', `${env.CLIENT_ORIGIN}.evil.test`]
      .map(Origin => ({ Origin, 'X-Liangmu-CSRF': '1' })),
    ...['https://evil.example.test/page', 'not-a-url']
      .map(Referer => ({ Referer, 'X-Liangmu-CSRF': '1' })),
  ]
  for (const headers of rejectedHeaders) {
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'CSRF_REJECTED')
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

test('正确来源或 CLI 自定义头可退出；自定义头本身不授予登录身份', async () => {
  const acceptedHeaders: Record<string, string>[] = [
    { 'X-Liangmu-CSRF': '1', Origin: env.CLIENT_ORIGIN },
    { 'X-Liangmu-CSRF': '1', Referer: `${env.CLIENT_ORIGIN}/profile` },
    { 'X-Liangmu-CSRF': '1' },
  ]
  for (const headers of acceptedHeaders) {
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('set-cookie')!, /^liangmu_session=;/)
  }
  const privateWrite = await fetch(`${base}/api/batches`, {
    method: 'POST', headers: { 'X-Liangmu-CSRF': '1', Origin: env.CLIENT_ORIGIN },
  })
  assert.equal(privateWrite.status, 401)
})

test('CORS 与无 Origin 都不能绕过认证；跨域客户端可读取 Retry-After', async () => {
  const response = await fetch(`${base}/api/batches`, { headers: { Origin: env.CLIENT_ORIGIN } })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After')
  assert.equal((await fetch(`${base}/api/batches`)).status, 401)
})

test('真实 HTTP IP 限流：关闭代理时忽略伪造 XFF，可信代理只采信最近非可信地址', async () => {
  const original = env.TRUST_PROXY
  try {
    for (const proxy of ['off', 'loopback']) {
      env.TRUST_PROXY = envSchema.parse({ ...valid, TRUST_PROXY: proxy }).TRUST_PROXY
      // 从实际工厂读取配置；探针仅验证 Express IP 推导与限流，不连接业务数据库。
      const productionApp = createApp()
      const probe = express()
      probe.set('trust proxy', productionApp.get('trust proxy'))
      probe.use(rateLimit({ windowMs: 60_000, limit: 2,
        validate: { xForwardedForHeader: false }, // off 是本次有意测试的安全默认配置。
      }))
      probe.get('/ip', (req, res) => res.json({ ip: req.ip }))
      const probeServer = probe.listen(0, '127.0.0.1')
      await once(probeServer, 'listening')
      const url = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}/ip`
      try {
        for (let index = 0; index < 2; index++) {
          const result = await fetch(url, { headers: { 'X-Forwarded-For': `203.0.113.${index + 1}, 198.51.100.5` } })
          assert.equal(result.status, 200)
          assert.equal((await result.json()).ip, proxy === 'off' ? '127.0.0.1' : '198.51.100.5')
        }
        const limited = await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.5' } })
        assert.equal(limited.status, 429)
        assert.ok(limited.headers.get('retry-after'))
      } finally {
        await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()))
      }
    }
  } finally { env.TRUST_PROXY = original }
})
