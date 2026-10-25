import { sessionHeaders } from './helpers/session.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import express from 'express'
import { io as connect, type Socket } from 'socket.io-client'
import type { AuthService, AuthUser } from '../src/services/auth.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-human-chat-secret-0123456789abcdef'
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test'
const { chatPairKey, chatContactWhere, createChatService } = await import('../src/services/chat.js')
const { createChatRouter } = await import('../src/routes/chat.js')
const { createNotificationChanges } = await import('../src/services/notificationChanges.js')
const { attachNotificationRealtime } = await import('../src/realtime/notifications.js')
const { signAccessToken } = await import('../src/lib/token.js')
const { errorHandler } = await import('../src/middleware/error.js')

const actor = (id = 'admin-a', role: AuthUser['role'] = 'admin'): AuthUser => ({ id, username: id,
  displayName: id, email: `${id}@test.invalid`, role, organizationId: role === 'admin' ? null : `org-${id}`,
  organization: role === 'admin' ? null : { id: `org-${id}`, name: id, type: role } })
const contact = { id: 'buyer-b', username: 'buyer-b', displayName: '客服测试采购商', role: 'buyer' as const,
  organization: { name: '测试组织' } }
const requestId = '3ec31cbc-a41e-45ac-9e1f-63712aef14f7'
const date = new Date('2026-10-07T03:00:00Z')
function setup() {
  const messages: { id: string; conversationId: string; senderId: string; clientMessageId: string;
    sequence: number; content: string; createdAt: Date }[] = []
  let readSequence = 0, lastSequence = 0, accessible = true, fail = false
  const row = () => ({ id: 'conversation-1', lastSequence, participants: [
    { userId: 'admin-a', user: { ...contact, id: 'admin-a' } }, { userId: contact.id, user: contact },
  ] })
  const db = {
    user: { findFirst: async () => accessible ? contact : null },
    chatConversation: {
      findFirst: async (input: { where: { AND: unknown[] } }) => {
        assert.ok(input.where.AND.length === 2) // 成员范围与当前联系人范围缺一不可。
        return accessible ? row() : null
      },
      update: async () => ({ lastSequence: ++lastSequence }),
      upsert: async () => ({ id: 'conversation-1' }),
    },
    chatMessage: {
      findUnique: async (input: { where: { senderId_clientMessageId: { clientMessageId: string } } }) =>
        messages.find((item) => item.clientMessageId === input.where.senderId_clientMessageId.clientMessageId) ?? null,
      create: async (input: { data: Omit<(typeof messages)[number], 'id' | 'createdAt'> }) => {
        if (fail) throw new Error('database unavailable')
        const item = { ...input.data, id: `message-${messages.length + 1}`, createdAt: date }
        messages.push(item); return item
      },
      findMany: async () => [...messages].reverse(),
    },
    chatParticipant: { updateMany: async (input: { where: { readSequence: { lt: number }; userId: string }; data: { readSequence: number } }) => {
      assert.equal(input.where.userId, 'admin-a')
      if (readSequence < input.where.readSequence.lt) readSequence = input.data.readSequence
    } },
    async $transaction<T>(write: (tx: unknown) => Promise<T>) {
      const oldSequence = lastSequence
      try { return await write(db) } catch (error) { lastSequence = oldSequence; throw error }
    },
  }
  const hints: string[][] = [], changes = createNotificationChanges()
  changes.subscribe((ids) => hints.push(ids))
  return { service: createChatService(db as unknown as PrismaClient, changes), messages, hints,
    revoke: () => { accessible = false }, fail: () => { fail = true }, readSequence: () => readSequence }
}

test('人工会话唯一键与用户顺序无关，分隔符不产生碰撞', () => {
  assert.equal(chatPairKey('a', 'b'), chatPairKey('b', 'a'))
  assert.notEqual(chatPairKey('a:b', 'c'), chatPairKey('a', 'b:c'))
})
test('联系人范围排除本人/禁用账号，采购商只有平台管理员；内部范围绑定组织与批次', () => {
  const buyer = chatContactWhere(actor('buyer-a', 'buyer'))
  assert.deepEqual(buyer.id, { not: 'buyer-a' }); assert.equal(buyer.status, 'active')
  assert.equal((buyer.OR as unknown[]).length, 1)
  assert.equal(JSON.stringify(buyer).includes('platform'), true)
  const grower = JSON.stringify(chatContactWhere(actor('grower-a', 'grower')))
  assert.ok(grower.includes('processedBatches') && grower.includes('org-grower-a'))
  assert.ok(!grower.includes('"role":"buyer"'))
  const processor = JSON.stringify(chatContactWhere(actor('processor-a', 'processor')))
  assert.ok(processor.includes('grownBatches') && processor.includes('processorOrganizationId'))
})
test('人工会话公开 DTO 只包含联系人必要字段，双方复用同一会话', async () => {
  const { service, hints } = setup()
  const result = await service.open(actor(), contact.id)
  assert.equal(result.id, 'conversation-1'); assert.equal(result.contact.organizationName, '测试组织')
  assert.equal('email' in result.contact, false); assert.equal('organization' in result.contact, false)
  assert.deepEqual(hints, [['admin-a', 'buyer-b']])
})
test('权限撤销后联系人/历史/发送/已读都统一 404，失败不推送', async () => {
  const { service, revoke, hints } = setup(); revoke()
  await assert.rejects(service.open(actor(), contact.id), { status: 404 })
  await assert.rejects(service.history(actor(), 'conversation-1'), { status: 404 })
  await assert.rejects(service.send(actor(), 'conversation-1', { clientMessageId: requestId, content: '测试' }), { status: 404 })
  await assert.rejects(service.markRead(actor(), 'conversation-1', 1), { status: 404 })
  assert.equal(hints.length, 0)
})
test('发送落库派生 senderId/顺序，UUID 幂等；复用编号改内容返回 409', async () => {
  const { service, messages, hints } = setup()
  const input = { clientMessageId: requestId, content: '你好' }
  const first = await service.send(actor(), 'conversation-1', input)
  const again = await service.send(actor(), 'conversation-1', input)
  assert.deepEqual(first, again); assert.equal(messages.length, 1)
  assert.equal(first.item.senderId, 'admin-a'); assert.equal(first.item.sequence, 1)
  assert.equal(first.item.createdAt, date.toISOString()); assert.deepEqual(hints[0], ['admin-a', 'buyer-b'])
  await assert.rejects(service.send(actor(), 'conversation-1', { ...input, content: '不同原文' }), { status: 409 })
  const history = await service.history(actor(), 'conversation-1')
  assert.equal(history.items.length, 1); assert.equal(history.nextBefore, null)
})
test('发送事务失败不发布提示，历史不会出现未提交消息', async () => {
  const { service, messages, hints, fail } = setup(); fail()
  await assert.rejects(service.send(actor(), 'conversation-1', { clientMessageId: requestId, content: '失败' }))
  assert.equal(messages.length, 0); assert.equal(hints.length, 0)
})
test('已读游标只能前进，不能提前读取不存在的消息，提示仅给本人', async () => {
  const { service, hints, readSequence } = setup()
  await service.send(actor(), 'conversation-1', { clientMessageId: requestId, content: '测试' })
  await service.markRead(actor(), 'conversation-1', 1)
  await service.markRead(actor(), 'conversation-1', 0)
  assert.equal(readSequence(), 1); assert.deepEqual(hints.slice(1), [['admin-a'], ['admin-a']])
  await assert.rejects(service.markRead(actor(), 'conversation-1', 2), { status: 400 })
})
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function socketEvent(socket: Socket, name: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out: ${name}`)) }, 2500)
    function handler(...args: unknown[]) { clearTimeout(timer); resolve(args) }
    socket.once(name, handler)
  })
}
test('人工聊天 HTTP 严格校验、认证/私有缓存，不接受伪造 senderId/角色/组织', async () => {
  const auth: AuthService = { async login() { return actor() }, async currentUser(id) { return actor(id) } }
  const app = express(); app.use(express.json())
  const { service } = setup()
  app.use('/api/chat', createChatRouter(auth, service)); app.use(errorHandler)
  const server = createServer(app), url = await listen(server)
  const headers = { ...sessionHeaders(await signAccessToken('admin-a')), 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(`${url}/api/chat/conversations`)).status, 401)
    for (const [path, method, body] of [
      ['/contacts?userId=other', 'GET', undefined], ['/conversations?role=admin', 'GET', undefined],
      ['/conversations', 'POST', { recipientId: 'buyer-b', senderId: 'other' }],
      ['/conversations/conversation-1/messages', 'POST', { clientMessageId: requestId, content: ' ' }],
      ['/conversations/conversation-1/messages', 'POST', { clientMessageId: 'not-uuid', content: '测试' }],
      ['/conversations/conversation-1/messages', 'POST', { clientMessageId: requestId, content: '测试', organizationId: 'other' }],
      ['/conversations/conversation-1/messages?before=0', 'GET', undefined],
      ['/conversations/conversation-1/read', 'PATCH', { sequence: -1 }],
    ] as const) {
      assert.equal((await fetch(`${url}/api/chat${path}`, { headers, method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).status, 400, path)
    }
    const response = await fetch(`${url}/api/chat/conversations/conversation-1/messages`, { headers })
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const sent = await fetch(`${url}/api/chat/conversations/conversation-1/messages`, { headers, method: 'POST',
      body: JSON.stringify({ clientMessageId: requestId, content: ' 测试 ' }) })
    assert.equal(sent.status, 200)
    assert.equal((await sent.json()).item.content, '测试')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
test('会话创建和发送共用用户级限流，另一账号不共用额度', async () => {
  const auth: AuthService = { async login() { return actor() }, async currentUser(id) { return actor(id) } }
  const app = express(); app.use(express.json())
  app.use('/api/chat', createChatRouter(auth, setup().service)); app.use(errorHandler)
  const server = createServer(app), url = await listen(server)
  const headers = { ...sessionHeaders(await signAccessToken('admin-a')), 'Content-Type': 'application/json' }
  try {
    for (let i = 0; i < 30; i++) assert.equal((await fetch(`${url}/api/chat/conversations`, {
      method: 'POST', headers, body: JSON.stringify({ recipientId: contact.id }),
    })).status, 200)
    const limited = await fetch(`${url}/api/chat/conversations/conversation-1/messages`, { method: 'POST', headers,
      body: JSON.stringify({ clientMessageId: requestId, content: '测试' }) })
    assert.equal(limited.status, 429); assert.ok(limited.headers.get('Retry-After'))
    assert.equal((await fetch(`${url}/api/chat/conversations`, { method: 'POST',
      headers: { ...headers, ...sessionHeaders(await signAccessToken('admin-b')) },
      body: JSON.stringify({ recipientId: contact.id }),
    })).status, 200)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})
test('人工聊天 Socket 提示只给参与双方，复用通知连接但不混用事件/正文', async () => {
  const auth: AuthService = { async login() { return actor() }, async currentUser(id) { return actor(id) } }
  const notify = createNotificationChanges(), chats = createNotificationChanges()
  const server = createServer(), realtime = attachNotificationRealtime(server, auth, notify, 30_000, chats)
  const url = await listen(server)
  const sockets = await Promise.all(['admin-a', 'buyer-b', 'outsider'].map(async (id) => connect(url, {
    extraHeaders: sessionHeaders(await signAccessToken(id)), transports: ['websocket'], autoConnect: false, reconnection: false,
  })))
  try {
    await Promise.all(sockets.map(async (socket) => { const ready = socketEvent(socket, 'connect'); socket.connect(); await ready }))
    let outsider = 0, notices = 0
    sockets[2].on('chat:changed', () => outsider++)
    sockets[0].on('notifications:changed', () => notices++)
    const a = socketEvent(sockets[0], 'chat:changed'), b = socketEvent(sockets[1], 'chat:changed')
    chats.publish(['admin-a', 'buyer-b'])
    assert.deepEqual(await a, []); assert.deepEqual(await b, [])
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(outsider, 0); assert.equal(notices, 0)
  } finally { sockets.forEach((socket) => socket.disconnect()); await new Promise<void>((resolve) => realtime.close(() => resolve())) }
})
