import { authMode } from '../config/api'
import type { ApiUser, AuthSession, LoginInput } from '../types/auth'
import { advanceAuthRevision, getAuthSession, isUserRole, setAuthSession, clearAuthSession } from '../utils/auth'
import { ApiError, apiRequest, isAbortError, setAuthFailureHandler } from './api'
import { queryClient } from './queryClient'

type AuthState = {
  status: 'checking' | 'authenticated' | 'anonymous' | 'error'
  session: AuthSession | null
  message: string | null
  errorAction?: 'restore' | 'logout'
}
let state: AuthState = { status: 'checking', session: null, message: null }
const listeners = new Set<() => void>()
let revision = 0
let activeRequest: AbortController | null = null
let restorePromise: Promise<void> | null = null
let writeQueue: Promise<unknown> = Promise.resolve()
let pendingWrites = 0
let notifyAuthChange = () => undefined as void

export const getAuthSnapshot = () => state
export function subscribeAuth(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(next: AuthState) {
  state = next
  listeners.forEach((listener) => listener())
}
function cancelAuthWork() {
  revision++
  activeRequest?.abort()
  activeRequest = null
  restorePromise = null
  advanceAuthRevision()
}
function clearUserCache() {
  // 公开查询不依赖账号；过期/切账号时不能误取消正在读取的匿名档案。
  // 只豁免独立的 public-trace key，其他查询和所有提交缓存仍清空。
  const privateQueries = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'public-trace' }
  void queryClient.cancelQueries(privateQueries)
  queryClient.removeQueries(privateQueries)
  queryClient.getMutationCache().clear()
}

/** 401/旧实时连接只能清本地状态，不能发退出请求误清另一标签的新 Cookie。 */
export function invalidateAuth(message: string | null = null) {
  cancelAuthWork()
  clearAuthSession()
  clearUserCache()
  publish({ status: 'anonymous', session: null, message })
}
setAuthFailureHandler(invalidateAuth)

/** 登录与退出串行执行，让迟到 Set-Cookie 不覆盖后续操作；Chrome/Edge 原生锁也覆盖标签页。 */
function enqueueCookieWrite<T>(work: () => Promise<T>): Promise<T> {
  pendingWrites++
  const result = writeQueue.then(() => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request('liangmu-auth-cookie', work)
    }
    return work()
  }).finally(() => { pendingWrites-- })
  writeQueue = result.then(() => undefined, () => undefined)
  return result
}

/** 显式退出必须等后端清 Cookie；网络失败保留重试入口，不假装退出成功。 */
export async function logout(): Promise<boolean> {
  cancelAuthWork()
  const attempt = revision
  clearAuthSession()
  clearUserCache()
  if (authMode === 'demo') {
    publish({ status: 'anonymous', session: null, message: null })
    return true
  }
  publish({ status: 'checking', session: null, message: null })
  try {
    await enqueueCookieWrite(() => apiRequest('/auth/logout', {
      method: 'POST', auth: false, credentials: 'include',
    }))
    notifyAuthChange()
    if (revision !== attempt) return false
    publish({ status: 'anonymous', session: null, message: null })
    return true
  } catch {
    if (revision === attempt) publish({ status: 'error', session: null,
      message: '退出未完成，请检查网络后重试；浏览器中的登录凭证可能仍有效。', errorAction: 'logout' })
    return false
  }
}

function toSession(value: unknown): AuthSession {
  if (!value || typeof value !== 'object') throw new ApiError(0, 'INVALID_RESPONSE', '用户资料格式不正确')
  const user = value as ApiUser
  if (!isUserRole(user.role) || ![user.id, user.username, user.email, user.displayName].every((field) => typeof field === 'string')) {
    throw new ApiError(0, 'INVALID_RESPONSE', '用户资料格式不正确')
  }
  const organization = user.organization
  if (user.organizationId !== null && typeof user.organizationId !== 'string' ||
    organization !== null && (!organization || typeof organization.id !== 'string' || typeof organization.name !== 'string' || organization.id !== user.organizationId) ||
    organization === null && user.organizationId !== null) {
    throw new ApiError(0, 'INVALID_RESPONSE', '组织资料格式不正确')
  }
  const labels = { admin: '管理员', grower: '种植商', processor: '加工商', buyer: '采购商' }
  return {
    userId: user.id, role: user.role, username: user.username, displayName: user.displayName, email: user.email, roleLabel: labels[user.role],
    ...(organization ? { organizationId: organization.id, organizationName: organization.name } : {}),
    ...(user.role === 'grower' && organization ? { growerId: organization.id, growerName: organization.name } : {}),
    ...(user.role === 'processor' && organization ? { processorId: organization.id, processorName: organization.name } : {}),
  }
}

/** 首次挂载去重；Cookie 无法由 JS 探测，API 模式始终通过 /me 核实。 */
export function restoreAuth(force = false): Promise<void> {
  if (restorePromise) return restorePromise
  if (pendingWrites || !force && (state.status === 'authenticated' || state.status === 'anonymous')) return Promise.resolve()
  if (authMode === 'demo') {
    const session = getAuthSession()
    publish({ status: session ? 'authenticated' : 'anonymous', session, message: null })
    return Promise.resolve()
  }
  clearAuthSession()
  const previous = state.session
  const attempt = ++revision
  const controller = new AbortController()
  activeRequest = controller
  if (!previous) publish({ status: 'checking', session: null, message: null })
  restorePromise = (async () => {
    try {
      const response = await apiRequest<{ user: unknown }>('/auth/me', {
        auth: false, credentials: 'include', signal: controller.signal,
      })
      if (revision !== attempt) return
      const session = toSession(response.user)
      if (JSON.stringify(previous) !== JSON.stringify(session)) {
        advanceAuthRevision(session.userId)
        clearUserCache()
        publish({ status: 'authenticated', session, message: null })
      }
    } catch (error) {
      if (revision !== attempt || isAbortError(error)) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) invalidateAuth(previous ? error.message : null)
      else {
        advanceAuthRevision()
        clearUserCache()
        publish({ status: 'error', session: null, message: error instanceof Error ? error.message : '登录状态验证失败' })
      }
    } finally {
      if (revision === attempt) { restorePromise = null; activeRequest = null }
    }
  })()
  return restorePromise
}

export async function login(input: LoginInput): Promise<AuthSession> {
  cancelAuthWork()
  const attempt = revision
  clearAuthSession()
  clearUserCache()
  publish({ status: 'anonymous', session: null, message: null })
  let cookieIssued = false
  try {
    let session: AuthSession
    if (authMode === 'demo') {
      const { verifyStaticLogin } = await import('../mock/user/credentials')
      const result = verifyStaticLogin(input.role, input.account.includes('@') ? 'email' : 'username', input.account, input.password)
      if (!result) throw new ApiError(401, 'INVALID_CREDENTIALS', '账号、密码或所选角色不正确')
      session = result
    } else {
      return await enqueueCookieWrite(async () => {
        if (revision !== attempt) throw new DOMException('登录请求已取消', 'AbortError')
        // 不因新的登录/退出意图中止已发出的 Cookie 写请求，先收尾，再执行排队操作。
        const response = await apiRequest<{ user: unknown }>('/auth/login', {
          method: 'POST', body: input, auth: false, credentials: 'include',
        })
        cookieIssued = true
        if (revision !== attempt) throw new DOMException('登录请求已取消', 'AbortError')
        const expected = toSession(response.user)
        const current = await apiRequest<{ user: unknown }>('/auth/me', { auth: false, credentials: 'include' })
        session = toSession(current.user)
        if (expected.userId !== session.userId) throw new ApiError(409, 'SESSION_CHANGED', '登录账号已变化，请重新登录')
        if (revision !== attempt) throw new DOMException('登录请求已取消', 'AbortError')
        advanceAuthRevision(session.userId)
        clearUserCache()
        publish({ status: 'authenticated', session, message: null })
        return session
      })
    }
    if (revision !== attempt) throw new DOMException('登录请求已取消', 'AbortError')
    try {
      setAuthSession(session)
    } catch {
      throw new ApiError(0, 'STORAGE_UNAVAILABLE', '浏览器禁止保存登录状态，请允许本站存储后重试')
    }
    clearUserCache()
    publish({ status: 'authenticated', session, message: null })
    advanceAuthRevision(session.userId)
    return session
  } catch (error) {
    if (revision === attempt && !isAbortError(error) && (cookieIssued || error instanceof ApiError && error.status === 0)) {
      publish({ status: 'error', session: null, message: '登录状态未确认，请重试验证或退出当前会话。' })
    }
    throw error
  } finally {
    if (cookieIssued) notifyAuthChange()
  }
}

/** 全局仅挂载一次；广播只提示重新核实身份，不传凭证或用户资料。 */
export function startAuthSync(): () => void {
  if (authMode !== 'api' || typeof window === 'undefined') return () => undefined
  const channel = typeof window.BroadcastChannel === 'function' ? new window.BroadcastChannel('liangmu-auth-sync-v1') : null
  let active = true
  const notify = () => { channel?.postMessage('changed') }
  notifyAuthChange = notify
  const refresh = () => { if (!pendingWrites) void restoreAuth(true) }
  if (channel) channel.onmessage = (event) => {
    if (!active || event.data !== 'changed' || pendingWrites) return
    invalidateAuth()
    refresh()
  }
  window.addEventListener('focus', refresh)
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible)
  return () => {
    active = false
    if (notifyAuthChange === notify) notifyAuthChange = () => undefined
    channel?.close()
    window.removeEventListener('focus', refresh)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible)
  }
}
