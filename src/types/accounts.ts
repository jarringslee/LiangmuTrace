export type BusinessRole = 'grower' | 'processor' | 'buyer'
export type AccountStatus = 'active' | 'disabled'
export const BUSINESS_ROLE_LABEL: Record<BusinessRole, string> = { grower: '种植商', processor: '加工商', buyer: '采购商' }
export type AccountIdentityInput = { username: string; email: string; displayName: string; password: string }
export type RegisterBuyerInput = AccountIdentityInput & { organizationName: string }
export type CreateAccountInput = AccountIdentityInput & { role: BusinessRole; organizationId: string }
export type BusinessAccount = {
  id: string; username: string; email: string; displayName: string; role: BusinessRole; status: AccountStatus
  organizationId: string | null; organizationName: string | null; organizationEnabled: boolean | null
}
export type AccountOrganization = { id: string; name: string; type: BusinessRole }
export type AccountDirectory = { users: BusinessAccount[]; organizations: AccountOrganization[]; truncated: boolean }
