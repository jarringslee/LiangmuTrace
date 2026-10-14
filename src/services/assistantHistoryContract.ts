import { ApiError } from './api'
import type { AssistantBatch, AssistantHistory, AssistantReply, AssistantTurn } from '../types/assistant'
import { parseGeneralAssistantReply } from './assistantContract'
import { isKnowledgeSourceUrl } from './knowledgeSourceUrl'

const fail = (): never => { throw new ApiError(0, 'INVALID_RESPONSE', 'AI 会话返回格式不正确') }
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function date(value: unknown): string {
  if (!text(value, 100) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) return fail()
  return value
}
function batchLabel(value: unknown): AssistantBatch | null {
  if (value === null) return null
  const item = record(value)
  if (!text(item.id, 150) || !text(item.herbName, 100) || !text(item.batchNo, 150)) return fail()
  return { id: item.id, herbName: item.herbName, batchNo: item.batchNo }
}
function reply(value: unknown, question: string, batch: AssistantBatch | null): AssistantReply {
  const item = record(value)
  if (item.scope === 'general') return parseGeneralAssistantReply(item, question, 'api')
  const knowledge = item.scope === 'knowledge'
  if (knowledge ? item.batchId !== null || !text(item.herbName, 100) || batch !== null
    : item.scope !== 'batch' || !batch || item.batchId !== batch.id) return fail()
  if (item.question !== question
    || !text(item.id, 150) || !text(item.answer, 3_000) || item.mode !== 'api'
    || item.status !== 'answered' && item.status !== 'insufficient'
    || item.modelName !== null && !text(item.modelName, 150)
    || item.status === 'answered' && item.modelName === null
    || !Array.isArray(item.citations) || item.citations.length > 6) return fail()
  const citations = item.citations.map((value): AssistantReply['citations'][number] => {
    const source = record(value)
    if (!text(source.id, 150) || !text(source.title, 200) || !text(source.publisher, 200)
      || source.kind !== 'batch' && source.kind !== 'knowledge') return fail()
    if (knowledge && source.kind !== 'knowledge') return fail()
    if (source.kind === 'batch' && source.url !== null) return fail()
    if (source.kind === 'knowledge') {
      if (!text(source.url, 500)) return fail()
      if (!isKnowledgeSourceUrl(source.url)) return fail()
    }
    // 只返回公开引用元信息，不把 excerpt / 原始上下文传进组件。
    return { id: source.id, kind: source.kind, title: source.title, publisher: source.publisher, url: source.url as string | null }
  })
  if (new Set(citations.map((source) => source.id)).size !== citations.length
    || item.status === 'answered' && !citations.length) return fail()
  return { id: item.id, scope: knowledge ? 'knowledge' : 'batch', batchId: knowledge ? null : batch!.id,
    ...(knowledge ? { herbName: item.herbName as string } : {}), question,
    answer: item.answer, status: item.status, citations, mode: 'api',
    modelName: item.modelName as string | null, createdAt: date(item.createdAt) }
}

export function parseAssistantTurn(value: unknown, expected?: { id: string; question: string }): AssistantTurn {
  const item = record(value)
  if (!text(item.id, 150) || !text(item.question, 500)
    || !['pending', 'done', 'error', 'stopped'].includes(item.status as string)
    || expected && (item.id !== expected.id || item.question !== expected.question)) return fail()
  const batch = batchLabel(item.batch), createdAt = date(item.createdAt)
  if (item.status === 'done' && !item.reply || item.status !== 'done' && item.reply !== undefined
    || item.error !== undefined && !text(item.error, 500)) return fail()
  return { id: item.id, question: item.question, batch, createdAt, status: item.status as AssistantTurn['status'],
    ...(item.status === 'done' ? { reply: reply(item.reply, item.question, batch) } : {}),
    ...(item.status === 'error' && item.error ? { error: item.error as string } : {}) }
}
export function parseAssistantHistory(value: unknown): AssistantHistory {
  const item = record(value)
  if (item.mode !== 'api' || item.conversationId !== null && !text(item.conversationId, 150)
    || !Array.isArray(item.turns) || item.turns.length > 40) return fail()
  const turns = item.turns.map((turn) => parseAssistantTurn(turn))
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) return fail()
  return { conversationId: item.conversationId as string | null, mode: 'api', turns }
}
