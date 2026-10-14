import { authMode } from '../config/api'
import { ApiError, apiRequest } from './api'
import type { AccountDirectory, AccountIdentityInput, AccountOrganization, AccountStatus, BusinessAccount, BusinessRole, CreateAccountInput, RegisterBuyerInput } from '../types/accounts'

const invalid = () => new ApiError(0, 'INVALID_RESPONSE', '账号资料格式不正确')
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const text = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 254) throw invalid()
  return value
}
const role = (value: unknown): BusinessRole => {
  if (value !== 'grower' && value !== 'processor' && value !== 'buyer') throw invalid()
  return value
}
export function parseBusinessAccount(value: unknown): BusinessAccount {
  const item = record(value)
  if (item.status !== 'active' && item.status !== 'disabled') throw invalid()
  const noOrg = item.organizationId === null
  if (noOrg ? item.organizationName !== null || item.organizationEnabled !== null : typeof item.organizationEnabled !== 'boolean') throw invalid()
  return { id: text(item.id), username: text(item.username), email: text(item.email), displayName: text(item.displayName),
    role: role(item.role), status: item.status, organizationId: noOrg ? null : text(item.organizationId),
    organizationName: noOrg ? null : text(item.organizationName), organizationEnabled: noOrg ? null : item.organizationEnabled as boolean }
}
export function parseAccountDirectory(value: unknown): AccountDirectory {
  const data = record(value)
  if (!Array.isArray(data.users) || !Array.isArray(data.organizations) || data.users.length > 200 || data.organizations.length > 200 || typeof data.truncated !== 'boolean') throw invalid()
  const users = data.users.map(parseBusinessAccount)
  const organizations: AccountOrganization[] = data.organizations.map(value => {
    const item = record(value)
    return { id: text(item.id), name: text(item.name), type: role(item.type) }
  })
  if (new Set(users.map(item => item.id)).size !== users.length || new Set(organizations.map(item => item.id)).size !== organizations.length) throw invalid()
  return { users, organizations, truncated: data.truncated }
}
function requireApi() {
  if (authMode !== 'api') throw new ApiError(0, 'DEMO_UNSUPPORTED', '离线演示不支持注册或账号管理，请连接真实 API')
}
// 明确挑选请求字段，确认密码仅用于前端校验，不传给接口，也不把公开注册变成角色选择。
const identity = (input: AccountIdentityInput) => ({ username: input.username, email: input.email, displayName: input.displayName, password: input.password })
export async function registerBuyer(input: RegisterBuyerInput) {
  requireApi()
  const result = record(await apiRequest<unknown>('/auth/register', { method: 'POST', auth: false,
    body: { ...identity(input), organizationName: input.organizationName } }))
  const account = record(result.account)
  if (account.role !== 'buyer') throw invalid()
  return { id: text(account.id), username: text(account.username) }
}
export async function listAccounts(signal?: AbortSignal) {
  requireApi()
  return parseAccountDirectory(await apiRequest<unknown>('/accounts', { signal }))
}
export async function createAccount(input: CreateAccountInput) {
  requireApi()
  const result = record(await apiRequest<unknown>('/accounts', { method: 'POST', body: { ...identity(input), role: input.role, organizationId: input.organizationId } }))
  return parseBusinessAccount(result.account)
}
export async function setAccountStatus(id: string, status: AccountStatus) {
  requireApi()
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ApiError(0, 'INVALID_INPUT', '账号编号不正确')
  const result = record(await apiRequest<unknown>(`/accounts/${id}/status`, { method: 'PATCH', body: { status } }))
  const account = parseBusinessAccount(result.account)
  if (account.id !== id || account.status !== status) throw invalid()
  return account
}
