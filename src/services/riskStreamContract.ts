import { ApiError } from './api'
import type { RiskAnalysis, RiskProgress } from '../types/riskAnalysis'

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const toolNames = ['get_batch_snapshot', 'inspect_trace_records']

export function parseRiskProgress(value: unknown, lastSeq: number): RiskProgress {
  if (!record(value) || value.seq !== lastSeq + 1
    || !['snapshot', 'model', 'tool', 'validate', 'save'].includes(String(value.stage))
    || !['running', 'completed'].includes(String(value.status))
    || typeof value.message !== 'string' || value.message.length > 500
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
    || value.toolName !== undefined && !toolNames.includes(String(value.toolName))) {
    throw new ApiError(0, 'STREAM_INVALID', '分析进度格式或顺序不正确')
  }
  return value as RiskProgress
}

export function parseRiskResult(value: unknown, batchId: string): RiskAnalysis {
  if (!record(value) || value.batchId !== batchId || typeof value.id !== 'string'
    || value.mode !== 'api' || value.stale !== false
    || !['normal', 'low', 'medium', 'high'].includes(String(value.riskLevel))
    || !['approve', 'manualReview', 'reject'].includes(String(value.recommendation))
    || typeof value.summary !== 'string' || typeof value.modelName !== 'string'
    || typeof value.createdAt !== 'string' || !['audit-risk-v1', 'audit-risk-v2'].includes(String(value.promptVersion))
    || !Number.isInteger(value.basedOnVersion) || !Number.isInteger(value.reviewVersion)
    || !strings(value.missingInformation) || !Array.isArray(value.evidence)
    || !value.evidence.every((item) => record(item) && typeof item.sourceId === 'string' && typeof item.note === 'string'
      && (item.sourceText === undefined ? value.promptVersion === 'audit-risk-v1'
        : typeof item.sourceText === 'string' && item.sourceText.length <= 600))
    || !Array.isArray(value.toolCalls) || !value.toolCalls.every((item) => record(item)
      && toolNames.includes(String(item.name)) && typeof item.summary === 'string' && typeof item.completedAt === 'string')) {
    throw new ApiError(0, 'STREAM_INVALID', '分析结果格式不正确或批次不匹配')
  }
  return value as RiskAnalysis
}

export function parseRiskStreamError(value: unknown): ApiError {
  if (!record(value) || typeof value.code !== 'string' || typeof value.message !== 'string'
    || typeof value.status !== 'number' || value.status < 400 || value.status > 599) {
    return new ApiError(0, 'STREAM_INVALID', '分析错误事件格式不正确')
  }
  return new ApiError(value.status, value.code, value.message)
}
