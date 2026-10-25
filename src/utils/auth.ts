import type { AuthSession, UserRole } from '../types/auth'

// 与旧版 Mock 登录隔离；API 模式绝不把本地用户资料当成服务端身份。
export const AUTH_STORAGE_KEY = 'liangmu_demo_auth_v2'
let authRevision = 0
let authUserId: string | null = null

/** 只在内存中隔离旧请求，不是认证凭证；Cookie 始终由浏览器与后端管理。 */
export const getAuthRevision = () => authRevision
export const getAuthUserId = () => authUserId
export function advanceAuthRevision(userId: string | null = null): number {
  authUserId = userId
  return ++authRevision
}

export function isUserRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'grower' || value === 'processor' || value === 'buyer'
}

export function parseAuthSession(raw: string | null): AuthSession | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !isUserRole(value.role)) return null
    if ([
      value.userId,
      value.username,
      value.displayName,
      value.email,
      value.roleLabel,
    ].some((item) => typeof item !== 'string')) {
      return null
    }
    const optionalFields = ['growerId', 'growerName', 'processorId', 'processorName', 'organizationId', 'organizationName']
    if (optionalFields.some((field) => value[field] !== undefined && typeof value[field] !== 'string')) return null
    return value as AuthSession
  } catch {
    return null
  }
}

export function getAuthSession(): AuthSession | null {
  try { return parseAuthSession(sessionStorage.getItem(AUTH_STORAGE_KEY)) } catch { return null }
}

export function setAuthSession(session: AuthSession): void {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
}

export function clearAuthSession(): void {
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    for (const key of [AUTH_STORAGE_KEY, 'liangmu_api_token_v1', 'liangmu_auth']) {
      try { globalThis[name].removeItem(key) } catch { /* 禁止 Web Storage 不影响 API Cookie 登录。 */ }
    }
  }
}

/** 仅允许站内相对路径，防止 open redirect */
export function sanitizeRedirectPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null
  if (path.includes('\\') || [...path].some((char) => char.charCodeAt(0) <= 32)) return null
  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
  if (pathname === '/login' || pathname === '') return null
  return path
}
