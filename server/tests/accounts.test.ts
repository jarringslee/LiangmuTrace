import assert from 'node:assert/strict'
import { once } from 'node:events'
import { after, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { compare, hash } from 'bcryptjs'
import type { AuthRecord } from '../src/services/auth.js'
import type { AccountRepository, BusinessAccount } from '../src/services/accounts.js'

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
process.env.JWT_SECRET = 'test-accounts-only-0123456789abcdef0123456789abcdef'
const { createAccountService, registerBuyerSchema, createAccountSchema, accountStatusSchema } = await import('../src/services/accounts.js')
const { createAccountRouter, createBuyerRegistrationRouter } = await import('../src/routes/accounts.js')
const { createAuthService } = await import('../src/services/auth.js')
const { createAuthRouter } = await import('../src/routes/auth.js')
const { errorHandler, HttpError } = await import('../src/middleware/error.js')
const { prisma } = await import('../src/lib/prisma.js')
const password = 'Test-account-123'
const passwordHash = await hash(password, 4)
const organizations = [{ id: 'org-buyer', name: '采购组织', type: 'buyer' as const }, { id: 'org-grower', name: '种植组织', type: 'grower' as const }]
const users = new Map<string, AuthRecord>(['admin', 'buyer'].map(role => [role, {
  id: role, username: role, email: `${role}@example.invalid`, displayName: role, role: role as 'admin' | 'buyer', status: 'active', passwordHash,
  organizationId: role === 'admin' ? null : 'org-buyer', organization: role === 'admin' ? null : { ...organizations[0]!, enabled: true },
}]))
const auth = createAuthService({ findById: async id => users.get(id) ?? null,
  findByAccount: async value => [...users.values()].find(item => item.username === value || item.email === value.toLowerCase()) ?? null })
const dto = (user: AuthRecord): BusinessAccount => ({ id: user.id, username: user.username, email: user.email, displayName: user.displayName,
  role: user.role, status: user.status, organizationId: user.organizationId, organizationName: user.organization?.name ?? null, organizationEnabled: user.organization?.enabled ?? null })
let capturedHash = '', writes = 0
const records: AccountRepository = {
  list: async () => ({ users: [...users.values()].filter(item => item.role !== 'admin').map(dto), organizations, truncated: false }),
  register: async input => {
    if ([...users.values()].some(item => item.username === input.username || item.email === input.email)) throw new HttpError(409, 'ACCOUNT_EXISTS', '用户名或邮箱已被使用')
    capturedHash = input.passwordHash; writes++
    const organization = { id: 'isolated-org', name: input.organizationName, type: 'buyer' as const, enabled: true }
    const user: AuthRecord = { ...input, id: 'registered', role: 'buyer', status: 'active', organizationId: organization.id, organization }
    users.set(user.id, user); return dto(user)
  },
  create: async input => {
    const organization = organizations.find(item => item.id === input.organizationId && item.type === input.role)
    if (!organization) throw new HttpError(409, 'ORGANIZATION_UNAVAILABLE', '组织不匹配')
    capturedHash = input.passwordHash; writes++
    const user: AuthRecord = { ...input, id: 'internal', status: 'active', organization: { ...organization, enabled: true } }
    users.set(user.id, user); return dto(user)
  },
  setStatus: async (id, status) => {
    const user = users.get(id)
    if (!user || user.role === 'admin') throw new HttpError(404, 'ACCOUNT_NOT_FOUND', '业务账号不存在')
    writes++; user.status = status; return dto(user)
  },
}
const service = createAccountService(records, auth)
function app() {
  const app = express(); app.use(express.json())
  app.use('/api/auth', createAuthRouter(auth), createBuyerRegistrationRouter(service))
  app.use('/api/accounts', createAccountRouter(auth, service)); app.use(errorHandler)
  return app
}
const server = app().listen(0, '127.0.0.1'); await once(server, 'listening')
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect() })
async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  return fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function login(account: string, role = account) {
  const response = await request('/api/auth/login', 'POST', { account, password, role }); assert.equal(response.status, 200)
  return (await response.json()).accessToken as string
}
const registration = { username: 'testbuyer', email: 'TEST@EXAMPLE.INVALID', displayName: '测试采购商', password, organizationName: '个人采购组织' }

test('注册与创建严格限制字段、角色和密码字节，邮箱规范化而密码不trim', () => {
  assert.equal(registerBuyerSchema.parse(registration).email, 'test@example.invalid')
  assert.equal(registerBuyerSchema.parse({ ...registration, password: '  abcdefgh  ' }).password, '  abcdefgh  ')
  for (const extra of [{ role: 'admin' }, { organizationId: 'org-buyer' }, { status: 'active' }, { passwordHash: 'forged' }]) {
    assert.equal(registerBuyerSchema.safeParse({ ...registration, ...extra }).success, false)
  }
  for (const value of ['abc', '药'.repeat(25), '        ']) assert.equal(registerBuyerSchema.safeParse({ ...registration, password: value }).success, false)
  assert.equal(createAccountSchema.safeParse({ ...registration, role: 'admin', organizationId: 'org-buyer' }).success, false)
  assert.equal(accountStatusSchema.safeParse({ status: 'deleted' }).success, false)
})

test('公开注册固定采购商/独立组织，返回201但不发Token或密码，重复账号409', async () => {
  const response = await request('/api/auth/register', 'POST', registration)
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { account: { id: 'registered', username: 'testbuyer', role: 'buyer' } })
  assert.ok(await compare(password, capturedHash)); assert.match(capturedHash, /^\$2[ab]\$12\$/)
  assert.equal(users.get('registered')!.organizationId, 'isolated-org')
  assert.equal((await request('/api/auth/register', 'POST', registration)).status, 409)
  assert.equal((await request('/api/auth/register', 'POST', { ...registration, role: 'admin' })).status, 400)
})

test('匿名及非管理员不能读写账号，管理员目录不包含hash或管理员；严格拒绝未知字段', async () => {
  const buyerToken = await login('buyer')
  for (const [method, body] of [['GET', undefined], ['POST', {}], ['PATCH', { status: 'disabled' }]] as const) {
    const path = method === 'PATCH' ? '/api/accounts/buyer/status' : '/api/accounts'
    assert.equal((await request(path, method, body)).status, 401)
    assert.equal((await request(path, method, body, buyerToken)).status, 403)
  }
  const token = await login('admin')
  const data = await (await request('/api/accounts', 'GET', undefined, token)).json()
  assert.ok(data.users.every((item: BusinessAccount) => item.role !== 'admin'))
  assert.doesNotMatch(JSON.stringify(data), /passwordHash/)
  assert.equal((await request('/api/accounts?role=admin', 'GET', undefined, token)).status, 400)
})

test('管理员只能创建匹配已有组织的业务账号，创建密码为bcrypt，不接受管理员角色', async () => {
  const token = await login('admin')
  const input = { username: 'growertest', email: 'growertest@example.invalid', displayName: '种植测试', password, role: 'grower', organizationId: 'org-grower' }
  assert.equal((await request('/api/accounts', 'POST', { ...input, organizationId: 'org-buyer' }, token)).status, 409)
  assert.equal((await request('/api/accounts', 'POST', { ...input, role: 'admin' }, token)).status, 400)
  const response = await request('/api/accounts', 'POST', input, token)
  assert.equal(response.status, 201); assert.ok(await compare(password, capturedHash))
  assert.doesNotMatch(JSON.stringify(await response.json()), /passwordHash/)
})

test('停用立即阻止登录及旧Token的me，保留账号记录，可重新启用；管理员不可停用', async () => {
  const adminToken = await login('admin'), buyerToken = await login('buyer')
  assert.equal((await request('/api/accounts/buyer/status', 'PATCH', { status: 'disabled' }, adminToken)).status, 200)
  assert.equal((await request('/api/auth/me', 'GET', undefined, buyerToken)).status, 403)
  assert.equal((await request('/api/auth/login', 'POST', { account: 'buyer', password, role: 'buyer' })).status, 403)
  assert.ok(users.has('buyer'))
  assert.equal((await request('/api/accounts/admin/status', 'PATCH', { status: 'disabled' }, adminToken)).status, 404)
  assert.equal((await request('/api/accounts/buyer/status', 'PATCH', { status: 'active' }, adminToken)).status, 200)
  assert.equal((await request('/api/auth/me', 'GET', undefined, buyerToken)).status, 200)
})

test('管理员身份在hash等待期间失效时，不执行账号写入', async () => {
  const actor = await auth.currentUser('admin'), before = writes
  const revoked = createAccountService(records, { currentUser: async () => ({ ...actor, role: 'buyer' }) })
  await assert.rejects(revoked.create(actor, { username: 'nobody', email: 'nobody@example.invalid', displayName: '不创建', password, role: 'buyer', organizationId: 'org-buyer' }), { code: 'FORBIDDEN' })
  assert.equal(writes, before)
})

test('公开注册失败尝试也计入限流，不靠IP伪造角色；第六次返回429', async () => {
  const other = app().listen(0, '127.0.0.1'); await once(other, 'listening')
  try {
    const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}/api/auth/register`
    for (let i = 0; i < 5; i++) assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400)
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 429); assert.ok(response.headers.get('retry-after'))
  } finally { await new Promise<void>(resolve => other.close(() => resolve())) }
})
