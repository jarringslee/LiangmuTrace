import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

let vite, contract, demo, source, storage, auth, queryClient
let ssrAuthFixture = false
const realFetch = globalThis.fetch
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const item = { id: 'notice-1', type: 'batchSubmitted', batchId: 'batch-1', title: '新批次', content: '请审核',
  createdAt: '2026-10-05T00:00:00Z', readAt: null }
const page = { items: [item], total: 1, unreadCount: 1, page: 1, pageSize: 10 }
beforeEach(async () => {
  ssrAuthFixture = false
  const store = new Map()
  const sessions = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value),
  } })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key) => sessions.get(key) ?? null, setItem: (key, value) => sessions.set(key, value),
    removeItem: (key) => sessions.delete(key),
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  vite = await createServer({ cacheDir: 'node_modules/.vite-tests/notifications', mode: 'development',
    plugins: [{ name: 'notification-ssr-auth-fixture', enforce: 'pre', load(id) {
      if (ssrAuthFixture && id.replace(/\\/g, '/').endsWith('/src/hooks/useAuth.ts')) {
        // 只为 mutation/cache Harness 提供身份快照，不模拟真实订阅；实际认证/Effect 另作浏览器验收。
        return `import { getAuthSnapshot } from '../services/auth';
          export function useAuth() { const state = getAuthSnapshot();
            return { ...state, isAuthenticated: state.status === 'authenticated' }; }`
      }
    } }],
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('api'), 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' })
  contract = await vite.ssrLoadModule('/src/services/notificationContract.ts')
  demo = await vite.ssrLoadModule('/src/services/notificationDemo.ts')
  source = await vite.ssrLoadModule('/src/services/notificationDataSource.ts')
  storage = await vite.ssrLoadModule('/src/utils/auth.ts')
  storage.advanceAuthRevision('user-A')
})
afterEach(async () => {
  auth?.invalidateAuth()
  auth = undefined
  queryClient?.clear()
  queryClient = undefined
  await vite.close()
  globalThis.fetch = realFetch
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window
  if (previousSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', previousSessionStorage); else delete globalThis.sessionStorage
})

test('通知响应只保留白名单，拒绝非法枚举/日期/计数/分页/重复 ID', () => {
  assert.deepEqual(contract.parseNotificationPage(page), page)
  assert.deepEqual(contract.parseNotification({ ...item, recipientId: 'private', metadata: { secret: true } }), item)
  for (const value of [
    { ...page, items: [{ ...item, type: 'chat' }] }, { ...page, items: [{ ...item, createdAt: 'bad' }] },
    { ...page, items: [{ ...item, readAt: false }] }, { ...page, pageSize: 0 }, { ...page, page: '1' },
    { ...page, unreadCount: -1 }, { ...page, total: 0 }, { ...page, items: [item, item], total: 2 },
  ]) assert.throws(() => contract.parseNotificationPage(value), { code: 'INVALID_RESPONSE' })
})

test('已读响应必须属于请求 ID 且真的已读，不能接受返回其他通知', () => {
  const read = { ...item, readAt: '2026-10-05T01:00:00Z' }
  assert.deepEqual(contract.parseReadNotification({ item: read }, item.id), read)
  assert.throws(() => contract.parseReadNotification({ item }, item.id), { code: 'INVALID_RESPONSE' })
  assert.throws(() => contract.parseReadNotification({ item: read }, 'other'), { code: 'INVALID_RESPONSE' })
})

test('demo 只列系统演示消息，正确筛选/分页与全量未读数', () => {
  const all = demo.listDemoNotifications({ page: 1, pageSize: 100, status: 'all' })
  assert.ok(all.total > 0); assert.ok(all.items.every((item) => item.type === 'system' && item.batchId === null))
  const read = demo.listDemoNotifications({ page: 1, pageSize: 1, status: 'read' })
  assert.equal(read.unreadCount, all.unreadCount); assert.ok(read.items.length <= 1)
  assert.ok(read.items.every((item) => item.readAt !== null))
  assert.ok(all.items.every((item) => Number.isFinite(Date.parse(item.createdAt))))
})

test('demo 已读持久化且幂等，事件订阅/清理正常；未知通知不创建记录', () => {
  const query = { page: 1, pageSize: 100, status: 'all' }
  const all = demo.listDemoNotifications(query), unread = all.items.find((item) => item.readAt === null)
  assert.ok(unread)
  let changes = 0
  const unsubscribe = demo.subscribeDemoNotifications(() => { changes++ })
  const first = demo.markDemoNotificationRead(unread.id), second = demo.markDemoNotificationRead(unread.id)
  assert.equal(first.readAt, second.readAt); assert.equal(changes, 1)
  assert.equal(demo.listDemoNotifications(query).unreadCount, all.unreadCount - 1)
  unsubscribe(); window.dispatchEvent(new Event('liangmu-demo-notification-read')); assert.equal(changes, 1)
  assert.throws(() => demo.markDemoNotificationRead('unknown'), { status: 404 })
})

test('通知数据源正确查询/编码路径、携带 Cookie 与取消信号，已读不提交收件人', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/notifications?page=2&pageSize=10&status=unread')
    assert.equal(options.credentials, 'include'); assert.equal(options.headers.Authorization, undefined); assert.ok(options.signal)
    return new Response(JSON.stringify({ ...page, page: 2, total: 11 }))
  }
  assert.equal((await source.listNotifications({ page: 2, pageSize: 10, status: 'unread' })).page, 2)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/notifications/id%2Fencoded/read'); assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), {})
    return new Response(JSON.stringify({ item: { ...item, id: 'id/encoded', readAt: '2026-10-05T01:00:00Z' } }))
  }
  assert.equal((await source.markNotificationRead('id/encoded')).id, 'id/encoded')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(source.listNotifications({ page: 1, pageSize: 10, status: 'all' }, controller.signal), { name: 'AbortError' })
})

test('通知业务失败不清登录，切换账号后丢弃旧查询/旧已读响应', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '无权限' } }), { status: 403 })
  await assert.rejects(source.markNotificationRead(item.id), { status: 403 })
  assert.equal(storage.getAuthUserId(), 'user-A')
  globalThis.fetch = async () => {
    storage.advanceAuthRevision('user-B')
    return new Response(JSON.stringify(page))
  }
  await assert.rejects(source.listNotifications({ page: 1, pageSize: 10, status: 'all' }), { name: 'AbortError' })
  storage.advanceAuthRevision('user-A')
  globalThis.fetch = async () => {
    storage.advanceAuthRevision('user-B')
    return new Response(JSON.stringify({ item: { ...item, readAt: '2026-10-05T01:00:00Z' } }))
  }
  await assert.rejects(source.markNotificationRead(item.id), { name: 'AbortError' })
  assert.equal(storage.getAuthUserId(), 'user-B')
})

test('非管理员通知 Hook 同样启用，已读只失效本用户缓存且失败不自动重试', async () => {
  auth = await vite.ssrLoadModule('/src/services/auth.ts')
  const user = { id: 'grower-a', username: 'grower-a', email: 'a@example.test', displayName: '种植商',
    role: 'grower', organizationId: 'grower-org',
    organization: { id: 'grower-org', name: '测试合作社', type: 'grower' } }
  globalThis.fetch = async () => new Response(JSON.stringify({ user }))
  await auth.restoreAuth()
  const { QueryClient, QueryClientProvider } = await vite.ssrLoadModule('@tanstack/react-query')
  ssrAuthFixture = true
  const { useNotifications } = await vite.ssrLoadModule('/src/hooks/useNotifications.ts')
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } })
  const ownKey = ['notifications', 'api', 'grower-a']
  const allKey = [...ownKey, { page: 1, pageSize: 10, status: 'all' }]
  const unreadKey = [...ownKey, { page: 1, pageSize: 5, status: 'unread' }]
  const otherKey = ['notifications', 'api', 'admin-b']
  const batchKey = ['herb-batches', 'api']
  for (const key of [allKey, unreadKey, otherKey, batchKey]) queryClient.setQueryData(key, page)
  let hook
  function Harness() { hook = useNotifications({ page: 1, pageSize: 10, status: 'all' }); return null }
  // SSR 验证 mutation/缓存；Socket 的 Effect、卸载与页面交互由浏览器验收。
  renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)))
  assert.deepEqual(hook.query.data, page)
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ item: { ...item, readAt: '2026-10-05T01:00:00Z' } })) }
  await hook.markRead.mutateAsync(item.id)
  assert.equal(calls, 1)
  for (const key of [allKey, unreadKey]) assert.equal(queryClient.getQueryState(key).isInvalidated, true)
  for (const key of [otherKey, batchKey]) assert.equal(queryClient.getQueryState(key).isInvalidated, false)
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '不存在' } }), { status: 404 }) }
  await assert.rejects(hook.markRead.mutateAsync('missing'), { status: 404 })
  assert.equal(calls, 2)
})

test('通知时间按上海时区展示，类型映射覆盖通知枚举', async () => {
  const { formatNotificationTime, notificationTypeLabels } = await vite.ssrLoadModule('/src/utils/notification.ts')
  assert.match(formatNotificationTime('2026-10-05T16:01:00Z'), /2026\/10\/06 00:01/)
  assert.equal(Object.keys(notificationTypeLabels).length, 5)
})
