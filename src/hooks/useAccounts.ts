import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authMode } from '../config/api'
import { createAccount, listAccounts, setAccountStatus } from '../services/accounts'
import type { AccountStatus } from '../types/accounts'
import { herbQueryKeys } from './useHerbBatches'
import { useAuth } from './useAuth'

export function useAccounts() {
  const client = useQueryClient()
  const { session, isAuthenticated } = useAuth()
  const queryKey = ['business-accounts', authMode, session?.userId ?? 'anonymous'] as const
  const query = useQuery({ queryKey, queryFn: ({ signal }) => listAccounts(signal), enabled: authMode === 'api' && isAuthenticated && session?.role === 'admin', refetchOnMount: 'always' })
  const invalidate = () => Promise.all([
    client.invalidateQueries({ queryKey }),
    // 新账号/停用可能影响出库候选组织、待处理联系人等，不能只更新账号表。
    client.invalidateQueries({ queryKey: ['dispatch-recipients'] }),
    client.invalidateQueries({ queryKey: ['human-chat'] }),
    client.invalidateQueries({ queryKey: herbQueryKeys.all }),
  ])
  const create = useMutation({ mutationFn: createAccount, retry: false, onSuccess: invalidate })
  const setStatus = useMutation({ mutationFn: ({ id, status }: { id: string; status: AccountStatus }) => setAccountStatus(id, status), retry: false, onSuccess: invalidate })
  return { query, create, setStatus }
}
