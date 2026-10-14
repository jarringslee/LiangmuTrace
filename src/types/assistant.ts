import type { Dispatch, SetStateAction } from 'react'
import type { HerbBatch } from './herb'
import type { HerbQuestionCitation } from './herbQuestion'

export type AssistantBatch = Pick<HerbBatch, 'id' | 'herbName' | 'batchNo'>
export type AssistantRequest = { question: string; batch: AssistantBatch | null }
export type AssistantReply = {
  id: string
  scope: 'general' | 'batch' | 'knowledge'
  herbName?: string
  batchId: string | null
  question: string
  status: 'answered' | 'insufficient'
  answer: string
  citations: Omit<HerbQuestionCitation, 'excerpt'>[]
  mode: 'api' | 'demo'
  modelName: string | null
  createdAt: string
}

// 一次提问对应一对气泡，固定记录发送时的批次，不依赖之后切换的标签。
export type AssistantTurn = AssistantRequest & {
  id: string
  createdAt: string
  status: 'pending' | 'done' | 'error' | 'stopped'
  reply?: AssistantReply
  error?: string
  // 只在前端保留的未校验预览，不能当作 reply 写入数据库或查询缓存。
  preview?: string
}

export type AssistantHistory = {
  conversationId: string | null
  mode: 'api' | 'demo'
  turns: AssistantTurn[]
}

export type AssistantContextValue = {
  open: boolean
  batch: AssistantBatch | null
  turns: AssistantTurn[]
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  isPending: boolean
  historyLoading: boolean
  historyError: string | null
  historyMode: 'api' | 'demo' | undefined
  conversationBusy: boolean
  reloadHistory: () => void
  openAssistant: (batch?: AssistantBatch | null) => void
  closeAssistant: () => void
  removeBatch: () => void
  send: (request?: AssistantRequest) => Promise<void>
  stop: () => void
}
