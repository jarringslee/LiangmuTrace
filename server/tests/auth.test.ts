import { sessionHeaders, loginToken } from './helpers/session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import express, { type Express } from 'express'
import { hash } from 'bcryptjs'
import { SignJWT, decodeJwt } from 'jose'
import type { AuthRecord } from '../src/services/auth.js'

// 必须先设置测试配置，再加载会读取环境变量的业务模块；不连接真实数据库。
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-secret-not-for-production-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { createApp } = await import('../src/app.js')
const { createAuthService } = await import('../src/services/auth.js')
const { authenticate, requireRoles } = await import('../src/middleware/auth.js')
const { errorHandler } = await import('../src/middleware/error.js')
const { env, envSchema } = await import('../src/config/env.js')
const { prisma } = await import('../src/lib/prisma.js')

const password = 'example-password'
const passwordHash = await hash(password, 4)
const roles = ['admin', 'grower', 'processor', 'buyer'] as const
const users = new Map<string, AuthRecord>(roles.map((role) => [role, {
  id: role, username: role, email: `${role}@example.com`, displayName: `${role} 测试用户`,
  role, status: 'active', passwordHash, organizationId: `org-${role}`,
  organization: { id: `org-${role}`, name: `${role} 组织`, type: role === 'admin' ? 'platform' : role, enabled: true },
}]))
const service = createAuthService({
  findByAccount: async (account) => [...users.values()].find(
    (user) => user.username === account || user.email.toLowerCase() === account.toLowerCase(),
  ) ?? null,
  findById: async (id) => users.get(id) ?? null,
})

async function start(app: Express) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}
const api = await start(createApp(service))
const guardedApp = express()
guardedApp.get('/admin', authenticate(service), requireRoles('admin'), (_req, res) => res.json({ ok: true }))
guardedApp.use(errorHandler)
const guarded = await start(guardedApp)
after(async () => {
  await Promise.all([api.close(), guarded.close()])
  await prisma.$disconnect()
})

function login(body: unknown, base = api.base) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { ...sessionHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}
async function tokenFor(role: string) {
  const response = await login({ account: role, password, role })
  assert.equal(response.status, 200)
  return loginToken(response)
}
function me(token?: string) {
  return fetch(`${api.base}/api/auth/me`, { headers: sessionHeaders(token) })
}
function handcraftedToken(options: { expired?: boolean; issuer?: string; audience?: string; alg?: string; sub?: string; noExp?: boolean } = {}) {
  const jwt = new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setSubject(options.sub ?? 'buyer').setIssuedAt()
    .setIssuer(options.issuer ?? 'LiangmuTrace')
    .setAudience(options.audience ?? 'LiangmuTrace-web')
  if (!options.noExp) jwt.setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 60 : '1h')
  return jwt.sign(new TextEncoder().encode(process.env.JWT_SECRET))
}

for (const role of roles) {
  test(`${role} 登录后能访问 /me，返回值不泄漏密码`, async () => {
    const response = await login({ account: role, password, role })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = await response.json()
    assert.equal(result.expiresIn, 3600)
    assert.equal('tokenType' in result, false)
    assert.equal('accessToken' in result, false)
    assert.equal(result.user.role, role)
    assert.equal(result.user.organizationId, `org-${role}`)
    assert.equal('passwordHash' in result.user, false)
    assert.equal('status' in result.user, false)
    const cookie = response.headers.get('set-cookie')!
    assert.match(cookie, /^liangmu_session=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Path=\/(?:;|$)/)
    assert.match(cookie, /Max-Age=3600/)
    assert.doesNotMatch(cookie, /Domain=|Secure/)
    const token = loginToken(response)
    const claims = decodeJwt(token)
    assert.equal(claims.sub, role)
    assert.equal(claims.role, undefined)
    assert.equal(claims.email, undefined)
    const current = await me(token)
    assert.equal(current.status, 200)
    assert.deepEqual((await current.json()).user, result.user)
  })
}

test('账号可去首尾空格，邮箱不区分大小写', async () => {
  assert.equal((await login({ account: '  ADMIN@EXAMPLE.COM  ', password, role: 'admin' })).status, 200)
})

test('参数错误返回 400，额外的组织字段不能注入', async () => {
  for (const body of [
    {}, { account: 'admin', password },
    { account: 'admin', password, role: 'superadmin' },
    { account: 'admin', password, role: 'admin', organizationId: 'other-org' },
    { account: 'admin', password: '药'.repeat(25), role: 'admin' },
  ]) {
    const response = await login(body)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR')
  }
})

test('错密码、不存在的账号、错角色都返回相同的 401', async () => {
  const results = []
  for (const body of [
    { account: 'admin', password: `${password} `, role: 'admin' },
    { account: 'absent', password, role: 'admin' },
    { account: 'admin', password, role: 'buyer' },
  ]) {
    const response = await login(body)
    assert.equal(response.status, 401)
    results.push(await response.json())
  }
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(results[1], results[2])
})

test('无 Cookie、乱码 Token 返回 401，合法 Bearer 也不能作为 Cookie 认证的兜底', async () => {
  assert.equal((await me()).status, 401)
  assert.equal((await me('bad-token')).status, 401)
  assert.equal((await fetch(`${api.base}/api/auth/me`, { headers: { Authorization: 'Basic abc' } })).status, 401)
  const token = await tokenFor('admin')
  assert.equal((await fetch(`${api.base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401)
  const invalidCookie = await fetch(`${api.base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, Cookie: 'liangmu_session=invalid' },
  })
  assert.equal(invalidCookie.status, 401)
})

test('期待用户ID只用于核对 Cookie 身份，不能冒充账号；旧标签身份不符返回409', async () => {
  const token = await tokenFor('admin')
  assert.equal((await fetch(`${api.base}/api/auth/me`, { headers: { 'X-Liangmu-User': 'admin' } })).status, 401)
  const ok = await fetch(`${api.base}/api/auth/me`, { headers: { ...sessionHeaders(token), 'X-Liangmu-User': 'admin' } })
  assert.equal(ok.status, 200)
  const stale = await fetch(`${api.base}/api/auth/me`, { headers: { ...sessionHeaders(token), 'X-Liangmu-User': 'buyer' } })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'SESSION_CHANGED')
})

test('Cookie 解析忽略无关字段，拒绝重复、空值、异常编码和超长认证 Cookie', async () => {
  const token = await tokenFor('admin')
  const read = (Cookie: string) => fetch(`${api.base}/api/auth/me`, { headers: { Cookie } })
  assert.equal((await read(`theme=light; liangmu_session=${token}; other=value`)).status, 200)
  for (const cookie of [`liangmu_session=${token}; liangmu_session=${token}`, 'liangmu_session=',
    'liangmu_session=%ZZ', `liangmu_session=${'a'.repeat(4097)}.b.c`]) {
    const response = await read(cookie)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'INVALID_TOKEN')
  }
})

test('退出幂等且不要求有效凭证，响应清除同路径 Cookie；不声称撤销已签发 JWT', async () => {
  const token = await tokenFor('admin')
  for (const value of [token, 'expired-or-forged', undefined]) {
    const response = await fetch(`${api.base}/api/auth/logout`, {
      method: 'POST', headers: sessionHeaders(value),
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const cookie = response.headers.get('set-cookie')!
    assert.match(cookie, /^liangmu_session=;/)
    assert.match(cookie, /Path=\/(?:;|$)/)
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.equal(await response.text(), '')
  }
  assert.equal((await me()).status, 401)
  // Node 显式重放旧 JWT 仍有效；本轮没有数据库 Session 或吊销列表。
  assert.equal((await me(token)).status, 200)
})

test('生产签发与清除 Cookie 都要求 Secure，不扩大 Domain 或跨站范围', async () => {
  const original = env.NODE_ENV
  env.NODE_ENV = 'production'
  try {
    const response = await login({ account: 'admin', password, role: 'admin' })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie')!, /; Secure(?:;|$)/)
    const logout = await fetch(`${api.base}/api/auth/logout`, { method: 'POST', headers: sessionHeaders() })
    assert.match(logout.headers.get('set-cookie')!, /; Secure(?:;|$)/)
    assert.doesNotMatch(logout.headers.get('set-cookie')!, /Domain=/)
  } finally { env.NODE_ENV = original }
})

test('拒绝过期、错误签发者/受众/算法、缺少过期时间的 Token', async () => {
  for (const options of [{ expired: true }, { issuer: 'other' }, { audience: 'other' }, { alg: 'HS384' }, { noExp: true }]) {
    const response = await me(await handcraftedToken(options))
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'INVALID_TOKEN')
  }
})

test('拒绝被篡改签名的 Token', async () => {
  const parts = (await tokenFor('admin')).split('.')
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
  assert.equal((await me(parts.join('.'))).status, 401)
})

test('禁用账号和组织返回 403，旧 Token 也不能继续访问', async () => {
  const user = users.get('grower')!
  const token = await tokenFor('grower')
  try {
    user.status = 'disabled'
    assert.equal((await login({ account: 'grower', password, role: 'grower' })).status, 403)
    assert.equal((await me(token)).status, 403)
    user.status = 'active'
    user.organization!.enabled = false
    assert.equal((await login({ account: 'grower', password, role: 'grower' })).status, 403)
    assert.equal((await me(token)).status, 403)
  } finally {
    user.status = 'active'
    user.organization!.enabled = true
  }
})

test('组织关系缺失或类型不匹配时拒绝访问', async () => {
  const user = users.get('processor')!
  const original = user.organization
  const token = await tokenFor('processor')
  try {
    user.organization = null
    assert.equal((await me(token)).status, 403)
    user.organization = { ...original!, type: 'buyer' }
    assert.equal((await me(token)).status, 403)
  } finally {
    user.organization = original
  }
})

test('已删除用户的有效 Token 返回 401', async () => {
  assert.equal((await me(await handcraftedToken({ sub: 'deleted-user' }))).status, 401)
})

test('角色守卫放行管理员、拒绝采购商，不信任 Token 中伪造的角色', async () => {
  assert.equal((await fetch(`${guarded.base}/admin`)).status, 401)
  const admin = await tokenFor('admin')
  assert.equal((await fetch(`${guarded.base}/admin`, { headers: { ...sessionHeaders(admin) } })).status, 200)
  const buyerWithAdminClaim = await handcraftedToken()
  assert.equal((await fetch(`${guarded.base}/admin`, { headers: { ...sessionHeaders(buyerWithAdminClaim) } })).status, 403)
})

test('角色调整后，旧 Token 立即按数据库中的新权限处理', async () => {
  const token = await tokenFor('admin')
  const user = users.get('admin')!
  try {
    user.role = 'buyer'
    user.organization!.type = 'buyer'
    const current = await me(token)
    assert.equal((await current.json()).user.role, 'buyer')
    assert.equal((await fetch(`${guarded.base}/admin`, { headers: { ...sessionHeaders(token) } })).status, 403)
  } finally {
    user.role = 'admin'
    user.organization!.type = 'platform'
  }
})

test('非法 JSON 和未知 API 使用统一错误格式', async () => {
  const malformed = await fetch(`${api.base}/api/auth/login`, {
    method: 'POST', headers: { ...sessionHeaders(), 'Content-Type': 'application/json' }, body: '{broken',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON')
  const missing = await fetch(`${api.base}/api/missing`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'NOT_FOUND')
})

test('数据库异常返回 500，不泄漏内部错误', async (context) => {
  const errorLog = context.mock.method(console, 'error', () => undefined)
  const failingApi = await start(createApp(createAuthService({
    findByAccount: async () => { throw new Error('simulated private database detail') },
    findById: async () => null,
  })))
  try {
    const response = await login({ account: 'admin', password, role: 'admin' }, failingApi.base)
    assert.equal(response.status, 500)
    const body = await response.text()
    assert.match(body, /INTERNAL_ERROR/)
    assert.equal(body.includes('private database detail'), false)
    assert.equal(errorLog.mock.callCount(), 1)
  } finally {
    await failingApi.close()
    errorLog.mock.restore()
  }
})

test('同一 IP 15 分钟超过 20 次失败返回 429', async () => {
  const limitedApi = await start(createApp(service))
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login({}, limitedApi.base)).status, 400)
    const response = await login({}, limitedApi.base)
    assert.equal(response.status, 429)
    assert.ok(response.headers.get('retry-after'))
    assert.equal((await response.json()).error.code, 'TOO_MANY_ATTEMPTS')
  } finally {
    await limitedApi.close()
  }
})

test('生产拒绝缺失/过短密钥，开发允许临时密钥', () => {
  const common = { DATABASE_URL: process.env.DATABASE_URL, CLIENT_ORIGIN: 'https://frontend.example.test' }
  assert.equal(envSchema.safeParse({ ...common, NODE_ENV: 'production' }).success, false)
  assert.equal(envSchema.safeParse({ ...common, NODE_ENV: 'production', JWT_SECRET: 'short' }).success, false)
  assert.equal(envSchema.safeParse({ ...common, NODE_ENV: 'production', JWT_SECRET: process.env.JWT_SECRET }).success, true)
  assert.equal(envSchema.safeParse({ ...common, NODE_ENV: 'development', JWT_SECRET: '' }).success, true)
})
