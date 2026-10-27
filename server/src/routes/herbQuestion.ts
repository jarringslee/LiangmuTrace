import { Router, type ErrorRequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.js'
import { HttpError } from '../middleware/error.js'
import type { AuthService } from '../services/auth.js'
import { herbQuestionSchema, type HerbQuestionService } from '../services/herbQuestion.js'
import { publicAssistantError } from '../services/assistantErrors.js'

export function createHerbQuestionRouter(auth: AuthService, service: HerbQuestionService) {
  const router = Router()
  // 保护问答路径，不拦截其他角色的普通批次路由。
  router.use('/:identifier/questions', authenticate(auth))
  const limiter = rateLimit({
    windowMs: 60_000, limit: 10, keyGenerator: (req) => req.auth!.id,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'AI_RATE_LIMITED', '问答请求过于频繁，请稍后重试')),
  })
  router.post('/:identifier/questions', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const identifier = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.identifier)
    const input = herbQuestionSchema.parse(req.body)
    const controller = new AbortController()
    const disconnected = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', disconnected)
    res.once('close', disconnected)
    try {
      const reply = await service.ask(req.auth!, identifier, input, controller.signal)
      // 防止模型等待期间账号被禁用，或组织/角色发生变化。
      const current = await auth.currentUser(req.auth!.id)
      if (current.role !== req.auth!.role || current.organizationId !== req.auth!.organizationId) {
        throw new HttpError(403, 'FORBIDDEN', '身份权限已经变化，请重新登录')
      }
      if (!controller.signal.aborted && !res.destroyed) res.json({ reply })
    } finally {
      req.off('aborted', disconnected)
      res.off('close', disconnected)
    }
  })
  const sanitize: ErrorRequestHandler = (error, _req, _res, next) => next(publicAssistantError(error))
  router.use(sanitize)
  return router
}
