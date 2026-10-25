import type { RequestHandler } from 'express'
import { env } from '../config/env.js'
import { HttpError } from './error.js'

export const CSRF_HEADER_NAME = 'X-Liangmu-CSRF'

/** API 写请求必须带自定义头；浏览器跨域发送该头会先预检，来源仍由服务端核对。 */
export const protectCookieWrites: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  let origin = req.get('Origin')
  const referer = req.get('Referer')
  if (!origin && referer) {
    try { origin = new URL(referer).origin } catch { origin = 'null' }
  }
  // 无来源头的 Node/CLI 仍需自定义头；它不是秘密，不替代 JWT 或角色/组织鉴权。
  if (req.get(CSRF_HEADER_NAME) !== '1' || origin !== undefined && origin !== env.CLIENT_ORIGIN) {
    return next(new HttpError(403, 'CSRF_REJECTED', '请求来源验证失败，请刷新页面后重试'))
  }
  next()
}
