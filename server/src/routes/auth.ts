import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../lib/token.js'
import { clearSessionCookie, setSessionCookie } from '../lib/sessionCookie.js'
import { authenticate } from '../middleware/auth.js'
import { HttpError } from '../middleware/error.js'
import type { AuthService } from '../services/auth.js'

const loginSchema = z.object({
  account: z.string().trim().min(1).max(254),
  // 密码不能 trim。bcrypt 只处理前 72 字节，主动拒绝超长输入，避免截断歧义。
  password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
  role: z.enum(['admin', 'grower', 'processor', 'buyer']),
}).strict()

export function createAuthRouter(service: AuthService) {
  const router = Router()
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20,
    standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true,
    handler: (_req, _res, next) => next(new HttpError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后重试')),
  })

  router.post('/login', loginLimiter, async (req, res) => {
    const input = loginSchema.parse(req.body)
    const user = await service.login(input.account, input.password, input.role)
    const accessToken = await signAccessToken(user.id)
    setSessionCookie(res, accessToken)
    res.json({ expiresIn: ACCESS_TOKEN_TTL_SECONDS, user })
  })
  // 即使凭证已过期、账号已停用也允许退出；全局 CSRF 中间件仍保护此写请求。
  router.post('/logout', (_req, res) => {
    clearSessionCookie(res)
    res.sendStatus(204)
  })
  router.get('/me', authenticate(service), (req, res) => {
    res.json({ user: req.auth })
  })
  return router
}
