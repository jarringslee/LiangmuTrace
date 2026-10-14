import { AUDIT_LABEL, type AuditStatus } from '../types/herb'
import type { RiskAnalysis, RiskProgress } from '../types/riskAnalysis'

/** 仅派生界面可操作状态；真正的权限、阶段和版本校验仍在服务端。 */
export function getRiskWorkbenchState(input: {
  auditStatus: AuditStatus
  analysis: RiskAnalysis | null | undefined
  analyzing: boolean
  reviewing: boolean
  reading: boolean
  readSuccess: boolean
  readPaused: boolean
}) {
  const { auditStatus, analysis, analyzing, reviewing, reading, readSuccess, readPaused } = input
  const analyzeReason = auditStatus !== 'pending'
    ? `该批次${AUDIT_LABEL[auditStatus]}。Agent 只分析待审核批次；这里只查看已有建议，不重启审核。`
    : reviewing ? '正在保存人工结论，请等待提交完成。'
      : analyzing ? '正在运行本次分析，请等待或停止，不重复调用模型。'
        : readPaused ? '读取已暂停，请恢复网络后重试读取。'
          : reading ? '正在读取最近保存的建议，请稍候。'
            : !readSuccess ? '尚未成功读取已有建议，请先重试读取，避免重复付费分析。'
              : null
  const reviewReason = analyzeReason ?? (!analysis
    ? '先运行分析并查看依据，再填写人工结论。'
    : analysis.stale ? '批次版本已变化，这份建议仅供查看；请重新分析后再提交。' : null)
  return {
    canAnalyze: analyzeReason === null,
    canReview: reviewReason === null,
    analyzeReason,
    reviewReason,
  }
}

export const RISK_TOOL_LABEL: Record<NonNullable<RiskProgress['toolName']>, string> = {
  get_batch_snapshot: '读取所选批次快照',
  inspect_trace_records: '检查当前阶段资料并整理依据',
}

export function riskProgressLabel(item: RiskProgress) {
  if (!item.toolName) return item.message
  return `${item.status === 'completed' ? '已完成' : '正在执行'}：${RISK_TOOL_LABEL[item.toolName]}`
}

export function riskEvidenceLabel(sourceId: string) {
  const labels: Record<string, string> = {
    'batch:identity': '批次基础信息',
    'batch:origin': '登记产地',
    'batch:environment': '种植环境',
  }
  return labels[sourceId] ?? (sourceId.startsWith('event:') ? '溯源记录' : '资料来源')
}
