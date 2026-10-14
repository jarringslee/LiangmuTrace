import { randomUUID } from 'node:crypto'
import { hash } from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../middleware/error.js'
import { createAuthService, type AuthService, type AuthUser } from './auth.js'

export const businessRoles = ['grower', 'processor', 'buyer'] as const
const identityFields = {
  username: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{2,29}$/, '用户名为3–30位字母、数字、下划线或短横线，且以字母开头'),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(50),
  // 不 trim 密码；拒绝 bcrypt 的72字节截断，中文与英文字符占用不同字节。
  password: z.string().min(8).max(72).refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 72),
}
export const registerBuyerSchema = z.object({ ...identityFields, organizationName: z.string().trim().min(1).max(80) }).strict()
export const createAccountSchema = z.object({ ...identityFields, role: z.enum(businessRoles), organizationId: z.string().min(1).max(100) }).strict()
export const accountStatusSchema = z.object({ status: z.enum(['active', 'disabled']) }).strict()
export type RegisterBuyerInput = z.infer<typeof registerBuyerSchema>
export type CreateAccountInput = z.infer<typeof createAccountSchema>

const accountSelect = { id: true, username: true, email: true, displayName: true, role: true, status: true,
  organizationId: true, organization: { select: { name: true, enabled: true } } } satisfies Prisma.UserSelect
type AccountRecord = Prisma.UserGetPayload<{ select: typeof accountSelect }>
export const accountDto = ({ organization, ...account }: AccountRecord) => ({ ...account,
  organizationName: organization?.name ?? null, organizationEnabled: organization?.enabled ?? null })
export type BusinessAccount = ReturnType<typeof accountDto>
export interface AccountRepository {
  list(): Promise<{ users: BusinessAccount[]; organizations: { id: string; name: string; type: typeof businessRoles[number] }[]; truncated: boolean }>
  register(input: Omit<RegisterBuyerInput, 'password'> & { passwordHash: string }): Promise<BusinessAccount>
  create(input: Omit<CreateAccountInput, 'password'> & { passwordHash: string }): Promise<BusinessAccount>
  setStatus(id: string, status: 'active' | 'disabled'): Promise<BusinessAccount>
}

async function assertUnique(tx: Prisma.TransactionClient, username: string, email: string) {
  if (await tx.user.findFirst({ where: { OR: [{ username }, { email: { equals: email, mode: 'insensitive' } }] }, select: { id: true } })) {
    throw new HttpError(409, 'ACCOUNT_EXISTS', '用户名或邮箱已被使用')
  }
}
const repository: AccountRepository = {
  list: () => prisma.$transaction(async tx => {
    const users = await tx.user.findMany({ where: { role: { in: [...businessRoles] } }, select: accountSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 201 })
    const organizations = await tx.organization.findMany({ where: { type: { in: [...businessRoles] }, enabled: true },
      select: { id: true, name: true, type: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 201 })
    return { users: users.slice(0, 200).map(accountDto), organizations: organizations.slice(0, 200).map(item => ({ ...item,
      type: item.type as typeof businessRoles[number] })), truncated: users.length > 200 || organizations.length > 200 }
  }),
  register: input => prisma.$transaction(async tx => {
    const { organizationName, ...account } = input
    await assertUnique(tx, account.username, account.email)
    // 无验证地认领已有采购组织会越权：自注册固定 buyer，并新建自己的独立组织。
    const organization = await tx.organization.create({ data: { code: `buyer-${randomUUID()}`, name: organizationName, type: 'buyer' } })
    return accountDto(await tx.user.create({ data: { ...account, role: 'buyer', status: 'active', organizationId: organization.id }, select: accountSelect }))
  }),
  create: input => prisma.$transaction(async tx => {
    const organization = await tx.organization.findFirst({ where: { id: input.organizationId, type: input.role, enabled: true }, select: { id: true } })
    if (!organization) throw new HttpError(409, 'ORGANIZATION_UNAVAILABLE', '请选择启用且与角色匹配的组织')
    await assertUnique(tx, input.username, input.email)
    return accountDto(await tx.user.create({ data: { ...input, status: 'active' }, select: accountSelect }))
  }),
  setStatus: (id, status) => prisma.$transaction(async tx => {
    // 条件直接限制业务角色；不允许停用自己或任何管理员，也不物理删除历史关联。
    const result = await tx.user.updateMany({ where: { id, role: { in: [...businessRoles] } }, data: { status } })
    if (result.count !== 1) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', '业务账号不存在')
    return accountDto(await tx.user.findUniqueOrThrow({ where: { id }, select: accountSelect }))
  }),
}

async function mapDuplicate<T>(operation: () => Promise<T>) {
  try { return await operation() } catch (error) {
    // 先查重改善提示，数据库唯一约束继续防止并发注册产生重复账号。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'ACCOUNT_EXISTS', '用户名或邮箱已被使用')
    }
    throw error
  }
}

export function createAccountService(records: AccountRepository = repository, auth: Pick<AuthService, 'currentUser'> = createAuthService()) {
  const adminOnly = async (user: AuthUser) => {
    if (user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '仅管理员可管理业务账号')
    const current = await auth.currentUser(user.id)
    if (current.role !== 'admin' || current.organizationId !== user.organizationId) throw new HttpError(403, 'FORBIDDEN', '管理员身份已变化，请重新登录')
  }
  return {
    async register(value: RegisterBuyerInput) {
      const { password, ...input } = registerBuyerSchema.parse(value)
      const passwordHash = await hash(password, 12)
      return mapDuplicate(() => records.register({ ...input, passwordHash }))
    },
    async list(user: AuthUser) { await adminOnly(user); return records.list() },
    async create(user: AuthUser, value: CreateAccountInput) {
      const { password, ...input } = createAccountSchema.parse(value)
      if (user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '仅管理员可管理业务账号')
      const passwordHash = await hash(password, 12)
      await adminOnly(user)
      return mapDuplicate(() => records.create({ ...input, passwordHash }))
    },
    async setStatus(user: AuthUser, id: string, value: { status: 'active' | 'disabled' }) {
      const { status } = accountStatusSchema.parse(value)
      await adminOnly(user)
      return records.setStatus(id, status)
    },
  }
}
export type AccountService = ReturnType<typeof createAccountService>
