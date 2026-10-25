import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

let vite, contract, source, storage
const realFetch = globalThis.fetch
const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const contact = { id: 'peer-1', username: 'peer', displayName: '平台客服', role: 'admin', organizationName: '良木药谷' }
const uuid = '3ec31cbc-a41e-45ac-9e1f-63712aef14f7'
const message = { id: 'msg-1', conversationId: 'chat-1', senderId: 'self', clientMessageId: uuid,
  sequence: 1, content: '测试消息', createdAt: '2026-10-07T03:00:00Z' }
const history = { conversationId: 'chat-1', contact, items: [message], nextBefore: null }
const conversations = { items: [{ id: 'chat-1', contact, lastMessage: message, unreadCount: 0,
  updatedAt: '2026-10-07T03:00:00Z' }], hasMore: false }
beforeEach(async () => {
  const sessions = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => sessions.get(key) ?? null, setItem: (key, value) => sessions.set(key, value),
    removeItem: (key) => sessions.delete(key),
  } })
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/chat',
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('api'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  contract = await vite.ssrLoadModule('/src/services/chatContract.ts')
  source = await vite.ssrLoadModule('/src/services/chatDataSource.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts'); storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  await vite.close(); globalThis.fetch = realFetch
  if (originalSession) Object.defineProperty(globalThis, 'sessionStorage', originalSession); else delete globalThis.sessionStorage
})
test('人工聊天契约只保留白名单，拒绝角色伪值/非法日期/负未读数/重复会话', () => {
  assert.deepEqual(contract.parseChatContact({ ...contact, email: 'private', passwordHash: 'secret' }), contact)
  assert.deepEqual(contract.parseChatConversations(conversations), conversations)
  for (const value of [
    { ...conversations, items: [{ ...conversations.items[0], contact: { ...contact, role: ['admin'] } }] },
    { ...conversations, items: [{ ...conversations.items[0], unreadCount: -1 }] },
    { ...conversations, items: [{ ...conversations.items[0], updatedAt: 'bad' }] },
    { ...conversations, items: [conversations.items[0], conversations.items[0]] },
    { ...conversations, hasMore: 'false' },
  ]) assert.throws(() => contract.parseChatConversations(value), { code: 'INVALID_RESPONSE' })
})
test('历史不能混入其他会话或乱序/重复消息，分页游标必须指向首条', () => {
  assert.deepEqual(contract.parseChatHistory(history, 'chat-1'), history)
  for (const value of [
    { ...history, conversationId: 'other' },
    { ...history, items: [{ ...message, conversationId: 'other' }] },
    { ...history, items: [message, message] },
    { ...history, items: [{ ...message, sequence: 0 }] },
    { ...history, nextBefore: 2 }, { ...history, items: [], nextBefore: 1 },
  ]) assert.throws(() => contract.parseChatHistory(value, 'chat-1'), { code: 'INVALID_RESPONSE' })
})
test('发送响应必须匹配会话、UUID 和原文，已读响应匹配请求会话', () => {
  assert.deepEqual(contract.parseChatSent({ item: message }, 'chat-1', uuid, ' 测试消息 '), message)
  assert.throws(() => contract.parseChatSent({ item: message }, 'other', uuid, message.content), { code: 'INVALID_RESPONSE' })
  assert.throws(() => contract.parseChatSent({ item: message }, 'chat-1', 'other', message.content), { code: 'INVALID_RESPONSE' })
  assert.throws(() => contract.parseChatSent({ item: message }, 'chat-1', uuid, '其他内容'), { code: 'INVALID_RESPONSE' })
  assert.throws(() => contract.parseChatRead({ conversationId: 'other' }, 'chat-1'), { code: 'INVALID_RESPONSE' })
})
test('数据源正确编码联系人搜索、携带 Cookie，只提交收件人而非发送人', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/chat/contacts?search=%E5%B9%B3%E5%8F%B0'); assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined)
    return new Response(JSON.stringify({ items: [contact], hasMore: false }))
  }
  assert.equal((await source.listChatContacts('平台')).items.length, 1)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/chat/conversations'); assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { recipientId: 'peer-1' })
    return new Response(JSON.stringify({ id: 'chat-1', contact }))
  }
  assert.equal((await source.openChat('peer-1')).id, 'chat-1')
})
test('历史路径/游标、发送 UUID 与已读位置通过统一请求层，重试复用原请求', async () => {
  let count = 0
  globalThis.fetch = async (url, options) => {
    count++
    if (count === 1) {
      assert.equal(url, '/api/chat/conversations/chat-1/messages?before=42')
      return new Response(JSON.stringify(history))
    }
    if (count <= 3) {
      assert.equal(url, '/api/chat/conversations/chat-1/messages'); assert.equal(options.method, 'POST')
      assert.deepEqual(JSON.parse(options.body), { clientMessageId: uuid, content: message.content })
      return new Response(JSON.stringify({ item: message }))
    }
    assert.equal(url, '/api/chat/conversations/chat-1/read'); assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { sequence: 1 })
    return new Response(JSON.stringify({ conversationId: 'chat-1' }))
  }
  await source.listChatHistory('chat-1', 42)
  const input = { clientMessageId: uuid, content: message.content }
  assert.deepEqual(await source.sendChat('chat-1', input), await source.sendChat('chat-1', input))
  await source.readChat('chat-1', 1); assert.equal(count, 4)
})
test('切账号后丢弃旧聊天响应，权限错误保持结构化状态', async () => {
  globalThis.fetch = async () => {
    storage.advanceAuthRevision('user-B'); return new Response(JSON.stringify(conversations))
  }
  await assert.rejects(source.listChatConversations(), { name: 'AbortError' })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'CHAT_NOT_FOUND', message: '无法访问' } }), { status: 404 })
  await assert.rejects(source.listChatHistory('chat-1', undefined), { status: 404, code: 'CHAT_NOT_FOUND' })
})
test('demo 人工聊天禁用真实网络，不伪造数据库消息', async () => {
  await vite.close()
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/chat-demo',
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('demo') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  const demoSource = await vite.ssrLoadModule('/src/services/chatDataSource.ts')
  globalThis.fetch = () => { throw new Error('demo 不应发起网络请求') }
  await assert.rejects(demoSource.listChatConversations(), { code: 'CHAT_API_REQUIRED' })
  await assert.rejects(demoSource.sendChat('chat-1', { clientMessageId: uuid, content: '测试' }), { code: 'CHAT_API_REQUIRED' })
})
