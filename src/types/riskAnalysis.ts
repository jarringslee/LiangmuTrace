import type { RiskLevel } from './herb'

export type RiskRecommendation = 'approve' | 'manualReview' | 'reject'
export const RECOMMENDATION_LABEL: Record<RiskRecommendation, string> = {
  approve: '建议通过',
  manualReview: '需要人工复核',
  reject: '建议驳回',
}

export type RiskAnalysis = {
  id: string
  batchId: string
  basedOnVersion: number
  reviewVersion: number
  modelName: string
  promptVersion: 'audit-risk-v1' | 'audit-risk-v2'
  createdAt: string
  mode: 'api' | 'demo'
  riskLevel: RiskLevel
  recommendation: RiskRecommendation
  summary: string
  missingInformation: string[]
  evidence: { sourceId: string; note: string; sourceText?: string }[]
  toolCalls: {
    name: 'get_batch_snapshot' | 'inspect_trace_records'
    summary: string
    completedAt: string
  }[]
  /** 批次变更或已经审核后，旧建议不能再提交。 */
  stale: boolean
}

export type RiskReviewInput = {
  decision: 'approved' | 'rejected'
  riskLevel: RiskLevel
  reason: string
}

/** 按本次请求的 seq 排序；与最后保存的工具调用记录分开。 */
export type RiskProgress = {
  seq: number
  stage: 'snapshot' | 'model' | 'tool' | 'validate' | 'save'
  status: 'running' | 'completed'
  message: string
  toolName?: 'get_batch_snapshot' | 'inspect_trace_records'
  at: string
}
