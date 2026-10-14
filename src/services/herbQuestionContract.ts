import { ApiError } from './api'
import type { HerbQuestionReply } from '../types/herbQuestion'
import { isKnowledgeSourceUrl } from './knowledgeSourceUrl'

/** TypeScript 不校验网络 JSON；渲染和打开来源链接前检查实际数据。 */
export function parseHerbQuestionReply(value: unknown, batchId: string): HerbQuestionReply {
  const validText = (item: unknown, max: number): item is string =>
    typeof item === 'string' && item.trim().length > 0 && item.length <= max
  const validUrl = (url: unknown) => {
    if (url === null) return true
    return isKnowledgeSourceUrl(url)
  }
  const fail = () => { throw new ApiError(0, 'INVALID_RESPONSE', '问答服务返回格式不正确') }
  if (!value || typeof value !== 'object') return fail()
  const result = value as Partial<HerbQuestionReply>
  if (!validText(result.id, 150) || result.batchId !== batchId || !validText(result.question, 500)
    || !validText(result.answer, 3_000) || !['answered', 'insufficient'].includes(result.status ?? '')
    || !['api', 'demo'].includes(result.mode ?? '') || !['bm25', 'demo'].includes(result.retrieval ?? '')
    || result.modelName !== null && !validText(result.modelName, 150)
    || !validText(result.knowledgeVersion, 100) || !validText(result.createdAt, 100)
    || !Number.isFinite(Date.parse(result.createdAt)) || !Array.isArray(result.citations)
    || result.citations.length > 6) return fail()
  for (const citation of result.citations) {
    if (!citation || typeof citation !== 'object' || !validText(citation.id, 150)
      || !['batch', 'knowledge'].includes(citation.kind) || !validText(citation.title, 200)
      || !validText(citation.excerpt, 800) || !validText(citation.publisher, 200)
      || !validUrl(citation.url) || citation.kind === 'knowledge' && citation.url === null
      || citation.kind === 'batch' && citation.url !== null) return fail()
  }
  if (result.status === 'answered' && !result.citations.length) return fail()
  return result as HerbQuestionReply
}
