import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

let vite, fixture, realtime
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
async function setup(mode = 'api') {
  vite = await createServer({ cacheDir: `node_modules/.vite-tests/realtime-${mode}`,
    server: { middlewareMode: true, hmr: false, watch: null },
    define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify(mode),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://liangmu-trace-api.onrender.com/api') },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    plugins: [{ name: 'notification-effect-fixture', enforce: 'pre',
      transform(code, id) {
        if (!id.replaceAll('\\', '/').endsWith('/src/hooks/useNotifications.ts')) return
        return code.replace(/from (['"])(react|@tanstack\/react-query|socket\.io-client|\.\/useAuth|\.\.\/utils\/auth|\.\.\/services\/notificationDemo)\1/g,
          "from 'virtual:notification-effect'")
      },
      resolveId(source) {
        if (source === 'virtual:notification-effect') return '\0virtual:notification-effect'
      },
      load(id) {
        if (id !== '\0virtual:notification-effect') return
        return `
          export const fixture = { token: 'token-A', session: { userId: 'user-A' }, authenticated: true,
            effect: null, calls: [], invalidations: [], sockets: [], logouts: [], demo: null }
          export const useEffect = (callback) => { fixture.effect = callback }
          export const useAuth = () => ({ session: fixture.session, isAuthenticated: fixture.authenticated,
            logout: (message) => fixture.logouts.push(message) })
          export const getAccessToken = () => fixture.token
          export const useQueryClient = () => ({ invalidateQueries: ({ queryKey }) => {
            fixture.invalidations.push(queryKey); return Promise.resolve()
          } })
          export const useQuery = () => { throw new Error('本文件仅测实时 Effect，不伪造查询') }
          export const useMutation = useQuery
          export const io = (url, options) => {
            const handlers = new Map()
            const socket = { url, options, handlers,
              on: (event, callback) => { fixture.calls.push(['on', event]); handlers.set(event, callback) },
              connect: () => fixture.calls.push(['connect']),
              disconnect: () => fixture.calls.push(['disconnect']),
              removeAllListeners: () => { fixture.calls.push(['remove']); handlers.clear() },
            }
            fixture.sockets.push(socket); return socket
          }
          export const subscribeDemoNotifications = (callback) => {
            fixture.demo = callback; return () => { fixture.demo = null; fixture.calls.push(['demo-cleanup']) }
          }
        `
      },
    }],
  })
  fixture = (await vite.ssrLoadModule('virtual:notification-effect')).fixture
  realtime = (await vite.ssrLoadModule('/src/hooks/useNotifications.ts')).useNotificationRealtime
}
beforeEach(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://liangmutrace.pages.dev' } } })
  await setup()
})
afterEach(async () => {
  await vite?.close()
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete globalThis.window
})
function start() {
  // 捕获并执行实际 Effect 回调；不声称模拟了 React 挂载调度、浏览器网络或断网。
  realtime()
  return fixture.effect()
}
const noticeKey = (user = 'user-A') => ['notifications', 'api', user]
const chatKey = (user = 'user-A') => ['human-chat', 'api', user]

test('实时 Effect 先注册监听再连接，connect/重连补查通知与聊天，聊天提示只补查聊天', () => {
  const cleanup = start(), socket = fixture.sockets[0]
  assert.equal(fixture.sockets.length, 1)
  assert.equal(socket.url, 'https://liangmu-trace-api.onrender.com')
  assert.deepEqual(socket.options, { path: '/socket.io', auth: { token: 'token-A' }, autoConnect: false })
  assert.deepEqual(fixture.calls, [
    ['on', 'connect'], ['on', 'notifications:changed'], ['on', 'chat:changed'],
    ['on', 'session:invalid'], ['on', 'connect_error'], ['connect'],
  ])
  for (let connection = 0; connection < 2; connection++) socket.handlers.get('connect')()
  assert.deepEqual(fixture.invalidations, [noticeKey(), chatKey(), noticeKey(), chatKey()])
  fixture.invalidations = []
  socket.handlers.get('chat:changed')()
  assert.deepEqual(fixture.invalidations, [chatKey()])
  fixture.invalidations = []
  socket.handlers.get('notifications:changed')()
  assert.deepEqual(fixture.invalidations, [noticeKey(), chatKey()])
  cleanup()
})

test('清理移除监听并断开连接，即使旧回调被排队也不刷新缓存或退出新身份', () => {
  const cleanup = start(), socket = fixture.sockets[0]
  const oldCallbacks = [...socket.handlers.entries()]
  cleanup()
  assert.equal(socket.handlers.size, 0)
  assert.deepEqual(fixture.calls.slice(-2), [['remove'], ['disconnect']])
  for (const [event, callback] of oldCallbacks) callback(event === 'connect_error' ? { data: { code: 'INVALID_TOKEN' } } : undefined)
  assert.deepEqual(fixture.invalidations, [])
  assert.deepEqual(fixture.logouts, [])
})

test('Token 变化后旧连接提示/失效事件被丢弃，新账号只失效自己的缓存键', () => {
  const cleanup = start(), old = fixture.sockets[0]
  fixture.token = 'token-B'
  for (const event of ['connect', 'notifications:changed', 'chat:changed', 'session:invalid']) old.handlers.get(event)()
  old.handlers.get('connect_error')({ data: { code: 'INVALID_TOKEN' } })
  assert.deepEqual(fixture.invalidations, [])
  assert.deepEqual(fixture.logouts, [])
  cleanup()
  fixture.session = { userId: 'user-B' }
  const cleanupNew = start(), current = fixture.sockets[1]
  assert.equal(current.options.auth.token, 'token-B')
  current.handlers.get('connect')()
  assert.deepEqual(fixture.invalidations, [noticeKey('user-B'), chatKey('user-B')])
  cleanupNew()
})

test('临时连接错误不清登录，明确的身份失效才断开并通知退出', () => {
  const cleanup = start(), socket = fixture.sockets[0]
  for (const error of [new Error('临时网络故障'), { data: { code: 'SERVER_UNAVAILABLE' } }]) socket.handlers.get('connect_error')(error)
  assert.deepEqual(fixture.logouts, [])
  socket.handlers.get('connect_error')({ data: { code: 'INVALID_TOKEN' } })
  assert.equal(fixture.logouts.length, 1)
  assert.deepEqual(fixture.calls.at(-1), ['disconnect'])
  socket.handlers.get('session:invalid')()
  assert.equal(fixture.logouts.length, 2)
  cleanup()
})

test('未登录或缺少 Token 时不建立真实连接', () => {
  fixture.authenticated = false
  assert.equal(start(), undefined)
  fixture.authenticated = true
  fixture.token = null
  assert.equal(start(), undefined)
  assert.deepEqual(fixture.sockets, [])
})

test('demo 只订阅本地通知事件，清理取消订阅，不调用真实 Socket', async () => {
  await vite.close(); await setup('demo')
  const cleanup = start()
  assert.deepEqual(fixture.sockets, [])
  fixture.demo()
  assert.deepEqual(fixture.invalidations, [['notifications', 'demo', 'user-A']])
  cleanup()
  assert.equal(fixture.demo, null)
  assert.deepEqual(fixture.calls, [['demo-cleanup']])
})
