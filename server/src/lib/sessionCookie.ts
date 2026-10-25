import type { CookieOptions, Response } from 'express'
import { env } from '../config/env.js'
import { HttpError } from '../middleware/error.js'
import { ACCESS_TOKEN_TTL_SECONDS } from './token.js'

export const SESSION_COOKIE_NAME = 'liangmu_session'

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    // REST 和 /socket.io 共用凭证；不设置 Domain，Cookie 只属于签发它的主机。
    path: '/',
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...cookieOptions(), maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  })
}

export function clearSessionCookie(res: Response): void {
  // 删除时沿用同一名称、路径及属性，不把清 Cookie 描述为 JWT 撤销。
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions())
}

/** 只读取本项目签发的 base64url JWT，不解析其他 Cookie，也不信任前端用户资料。 */
export function readSessionToken(header: string | undefined): string | null {
  let token: string | null = null
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue
    const value = part.slice(separator + 1).trim()
    // 拒绝重复同名 Cookie，避免 HTTP 与 Socket 对不同路径的凭证产生歧义。
    if (token !== null || value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
      throw new HttpError(401, 'INVALID_TOKEN', '登录凭证无效，请重新登录')
    }
    token = value
  }
  return token
}
