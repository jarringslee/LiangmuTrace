import type { RequestHandler } from 'express'
import type { UserRole } from '@prisma/client'
import type { AuthService, AuthUser } from '../services/auth.js'
import { verifyAccessToken } from '../lib/token.js'
import { readSessionToken } from '../lib/sessionCookie.js'
import { HttpError } from './error.js'

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser
  }
}

export function authenticate(service: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const token = readSessionToken(req.get('Cookie'))
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录')
    const userId = await verifyAccessToken(token)
    // 每次读取数据库状态，已签发 Token 的账号也能在禁用后立即失去访问权。
    req.auth = await service.currentUser(userId)
    // Cookie 跨标签共享；拒绝旧页面在账号变化后以另一个用户身份读写。
    const expectedUser = req.get('X-Liangmu-User')
    if (expectedUser && expectedUser !== req.auth.id) {
      throw new HttpError(409, 'SESSION_CHANGED', '登录账号已变化，请刷新页面后重试')
    }
    next()
  }
}

export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', '请先登录'))
    if (!roles.includes(req.auth.role)) return next(new HttpError(403, 'FORBIDDEN', '没有执行此操作的权限'))
    next()
  }
}
