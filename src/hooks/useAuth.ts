import { useSyncExternalStore } from 'react'
import { getAuthSnapshot, subscribeAuth, login, logout, restoreAuth, invalidateAuth } from '../services/auth'

export function useAuth() {
  // getAuthSnapshot 只在状态改变时返回新对象，防止无限重渲染。
  const state = useSyncExternalStore(subscribeAuth, getAuthSnapshot)
  return { ...state, isAuthenticated: state.status === 'authenticated', login, logout, restoreAuth, invalidateAuth }
}
