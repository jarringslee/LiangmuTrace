import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { authenticate, requireRoles } from '../middleware/auth.js'
import { HttpError } from '../middleware/error.js'
import type { AuthService } from '../services/auth.js'
import { accountStatusSchema, createAccountSchema, registerBuyerSchema, type AccountService } from '../services/accounts.js'

export function createBuyerRegistrationRouter(service: AccountService) {
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'REGISTRATION_LIMITED', '注册尝试过多，请稍后再试')) })
  router.post('/register', limiter, async (req, res) => {
    const account = await service.register(registerBuyerSchema.parse(req.body))
    // 注册不直接签发 JWT；客户端回到采购商登录，密码/hash 不进入响应。
    res.status(201).json({ account: { id: account.id, username: account.username, role: account.role } })
  })
  return router
}

export function createAccountRouter(auth: AuthService, service: AccountService) {
  const router = Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(authenticate(auth), requireRoles('admin'))
  router.get('/', async (req, res) => {
    z.object({}).strict().parse(req.query)
    res.json(await service.list(req.auth!))
  })
  router.post('/', async (req, res) => res.status(201).json({ account: await service.create(req.auth!, createAccountSchema.parse(req.body)) }))
  router.patch('/:id/status', async (req, res) => {
    const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.id)
    res.json({ account: await service.setStatus(req.auth!, id, accountStatusSchema.parse(req.body)) })
  })
  return router
}
