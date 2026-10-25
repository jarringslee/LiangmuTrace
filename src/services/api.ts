import { apiBaseUrl, authMode } from '../config/api'
import { getAuthRevision, getAuthUserId } from '../utils/auth'
import { readSseMessages, SseProtocolError, type SseMessage } from './sse'

export class ApiError extends Error {
  status: number
  code: string
  retryAfter: string | null
  constructor(status: number, code: string, message: string, retryAfter: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  auth?: boolean
  /** 登录/退出虽然不要求已有身份，仍必须接收或清除 Cookie；公开接口可明确省略。 */
  credentials?: RequestCredentials
  /** 普通请求默认 15 秒；多轮 AI 分析可单独配置。 */
  timeoutMs?: number
}

// 由登录状态模块注册，避免请求层依赖 React、路由或弹窗。
let onAuthFailure: (message: string) => void = () => undefined
export function setAuthFailureHandler(handler: typeof onAuthFailure) { onAuthFailure = handler }

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function responseError(response: Response, body: unknown, authenticated: boolean) {
  const errorBody = body && typeof body === 'object' && 'error' in body ? body.error : null
  const code = errorBody && typeof errorBody === 'object' && 'code' in errorBody && typeof errorBody.code === 'string'
    ? errorBody.code : `HTTP_${response.status}`
  const message = errorBody && typeof errorBody === 'object' && 'message' in errorBody && typeof errorBody.message === 'string'
    ? errorBody.message : response.status === 403 ? '没有执行此操作的权限' : '服务暂时不可用，请稍后重试'
  const accountBlocked = response.status === 403 && ['ACCOUNT_DISABLED', 'ORGANIZATION_DISABLED', 'INVALID_ORGANIZATION'].includes(code)
  if (authenticated && (response.status === 401 || accountBlocked || code === 'SESSION_CHANGED')) onAuthFailure(message)
  return new ApiError(response.status, code, message, response.headers.get('Retry-After'))
}

/** 所有业务 API 共用：Cookie、CSRF、超时、取消、错误格式和旧身份隔离。 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API path 必须为相对接口路径')
  const authenticated = options.auth !== false && authMode === 'api'
  const revision = getAuthRevision()
  const userId = authenticated ? getAuthUserId() : null
  const method = options.method ?? 'GET'
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  try {
    signal.throwIfAborted()
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: options.credentials ?? (options.auth === false ? 'omit' : 'include'),
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-Liangmu-CSRF': '1' }),
        ...(userId ? { 'X-Liangmu-User': userId } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    })
    const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
    signal.throwIfAborted()
    // A 账号发出的请求不能在切到 B 后写入 B 的页面，旧 401 也不能踢掉 B。
    if (authenticated && revision !== getAuthRevision()) throw new DOMException('登录身份已变化', 'AbortError')
    if (!response.ok) {
      throw responseError(response, body, authenticated)
    }
    if (body === undefined && response.status !== 204) throw new ApiError(0, 'INVALID_RESPONSE', '服务返回格式不正确')
    return body as T
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error) && !timeout.signal.aborted) throw error
    if (timeout.signal.aborted) throw new ApiError(0, 'TIMEOUT', '请求超时，请重试')
    if (error instanceof ApiError) throw error
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请检查网络后重试')
  } finally {
    clearTimeout(timer)
  }
}

/** POST + Cookie/CSRF 的 SSE 请求，不自动重连，避免重复执行付费分析。 */
export async function apiEventStream(
  path: string,
  options: RequestOptions & { onMessage: (message: SseMessage) => boolean },
): Promise<void> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API path 必须为相对接口路径')
  const authenticated = options.auth !== false && authMode === 'api'
  const revision = getAuthRevision()
  const userId = authenticated ? getAuthUserId() : null
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 70_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  let streamStarted = false
  const checkIdentity = () => {
    signal.throwIfAborted()
    if (authenticated && revision !== getAuthRevision()) throw new DOMException('登录身份已变化', 'AbortError')
  }
  try {
    checkIdentity()
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? 'POST',
      credentials: options.credentials ?? (options.auth === false ? 'omit' : 'include'),
      headers: {
        Accept: 'text/event-stream',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...((options.method ?? 'POST') === 'GET' ? {} : { 'X-Liangmu-CSRF': '1' }),
        ...(userId ? { 'X-Liangmu-User': userId } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal,
    })
    checkIdentity()
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined)
      checkIdentity()
      throw responseError(response, body, authenticated)
    }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream'
      || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new ApiError(0, 'STREAM_INVALID', '服务没有返回有效事件流')
    }
    streamStarted = true
    await readSseMessages(response.body, signal, (message) => {
      // 每帧都检查，切换账号后的旧进度/建议不能进入新账号页面。
      checkIdentity()
      return options.onMessage(message)
    })
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error) && !timeout.signal.aborted) throw error
    if (timeout.signal.aborted) throw new ApiError(0, 'TIMEOUT', 'AI 连接超时，请重新查询结果或手动重试')
    if (error instanceof ApiError) {
      // SSE 已开始时认证错误只能作为 error 帧返回，也要遵循普通 HTTP 的失效处理。
      if (streamStarted && authenticated && revision === getAuthRevision()
        && (error.status === 401 || error.code === 'SESSION_CHANGED' || error.status === 403 && ['ACCOUNT_DISABLED', 'ORGANIZATION_DISABLED', 'INVALID_ORGANIZATION'].includes(error.code))) onAuthFailure(error.message)
      throw error
    }
    if (error instanceof SseProtocolError) throw new ApiError(0, 'STREAM_INVALID', error.message)
    throw new ApiError(0, 'NETWORK_ERROR', 'AI 连接中断，请重新查询结果或手动重试')
  } finally {
    clearTimeout(timer)
  }
}
